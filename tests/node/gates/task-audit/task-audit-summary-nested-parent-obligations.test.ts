import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { appendMandatoryTaskEvent } from '../../../../src/gate-runtime/task-events';
import { buildStrictDecompositionDecisionArtifact } from '../../../../src/gates/task-mode/strict-decomposition-decision';
import { readNativeParentObligationProofs } from '../../../../src/gates/task-audit/task-audit-summary-parent-obligation-proofs';
import { writeActiveCompletionLock } from './task-audit-summary-fixtures';

const sourceApi = require('../../../../src/gates/task-audit/task-audit-summary-decomposed-parent-proofs');
const memoryApi = require('../../../../src/gates/project-memory-impact/project-memory-impact');
const modeApi = require('../../../../src/gates/task-mode/task-mode-evidence');
const gitApi = require('../../../../src/core/git-helpers');
const wipApi = require('../../../../src/gates/split-required/split-required-wip-runtime-handoff-contracts');
const wipFilesApi = require('../../../../src/gates/split-required/split-required-wip-restore-plan');
const parent = 'T-NESTED-1', nested = parent + '-1', leaf = parent + '-2', nestedLeaf = nested + '-1';
const nestedLeafTwo = nested + '-2';
const command = 'node --test original.test.js', hash = 'a'.repeat(64);

describe('native nested parent obligations', () => {
    let root: string, bundle: string, reviews: string, head: string;
    let leafReads: string[], commandReads: string[], missingLeaf: boolean;
    let beforeRootCommand: () => void, duringRootMemory: () => void;
    const timeline = (id: string) => path.join(bundle, 'runtime/task-events', id + '.jsonl');
    const memoryPath = (id: string) => path.join(bundle, 'runtime/project-memory', id + '-impact.json');
    const commandPath = (id: string) => path.join(reviews, id + '-command.json');
    const sourcePath = (id: string) => path.join(reviews, id + '-source.json');
    const wipPath = () => path.join(bundle, 'runtime/wip', nested, 'split-required/capture/manifest.json');
    const digest = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    const add = (id: string, type: string, details: object = {}, outcome: 'INFO' | 'PASS' | 'PASSED' | 'FAIL' | 'BLOCKED' = 'INFO') =>
        appendMandatoryTaskEvent(bundle, id, type, outcome, 'Isolated nested parent fixture.', details, { actor: 'orchestrator' });

    function writeParent(id: string, children: string[]) {
        fs.writeFileSync(path.join(reviews, id + '-task-mode.json'), '{}');
        fs.writeFileSync(path.join(reviews, id + '-preflight.json'), '{}');
        const artifact = buildStrictDecompositionDecisionArtifact({ taskId: id, decision: 'split-required',
            taskProfile: 'balanced', taskSummary: 'parent ' + id, reason: 'Bounded native nested children.',
            scopeRisk: 'Original obligations remain separate.', expectedReviewTypes: ['none'],
            atomicityConstraints: ['No fabricated aggregate SOURCE.'], proposedChildTaskIds: children,
            workPackageContract: { schema_version: 2, finding_obligations: [], work_packages: children.map((child, index) => ({
                task_id: child, profile: 'balanced', root_cause_area: 'nested-part-' + index,
                objective: 'Validate one native child scope.', scope_obligations: ['Only its native scope.'],
                validation_contract: ['Current native checks.'], finding_obligation_ids: [], required_review_types: []
            })) } });
        const artifactPath = path.join(reviews, id + '-strict-decomposition-decision.json');
        fs.writeFileSync(artifactPath, JSON.stringify(artifact));
        add(id, 'TASK_MODE_ENTERED', { dirty_workspace_baseline_count: 0, profile_policy_snapshot_hash: hash }, 'PASS');
        add(id, 'PREFLIGHT_CLASSIFIED', { changed_files_count: 0, changed_lines_total: 0,
            zero_diff_guard: { zero_diff_detected: true, status: 'BASELINE_ONLY' } });
        if (id === nested) {
            fs.mkdirSync(path.dirname(wipPath()), { recursive: true });
            fs.writeFileSync(wipPath(), JSON.stringify({ schema_version: 1, kind: 'split_required_wip',
                status: 'suspended', task_id: id, tracked_files: [], untracked_files: [], patches: {} }));
            add(id, 'SPLIT_REQUIRED_WIP_CAPTURED', { manifest_path: wipPath(), manifest_sha256: digest(wipPath()) }, 'BLOCKED');
        }
        add(id, 'STRICT_DECOMPOSITION_DECISION_RECORDED', {
            artifact_path: artifactPath.replace(/\\/gu, '/'), decision: artifact.decision,
            task_profile: artifact.task_profile, task_summary_sha256: artifact.task_summary_sha256,
            proposed_child_task_ids: children, work_package_contract_sha256: artifact.work_package_contract_sha256
        });
        add(id, 'DECOMPOSED_PARENT_COMPLETED', { previous_status: 'DECOMPOSED', new_status: 'DONE', reason: 'explicit_children_done' });
        fs.writeFileSync(commandPath(id), JSON.stringify({ task_id: id, command }));
        add(id, 'INTERMEDIATE_COMMAND_RUN', { command, artifact_path: commandPath(id), artifact_sha256: digest(commandPath(id)) }, 'PASSED');
        const memory = { task_id: id, outcome: 'PASS', impact_fingerprint_sha256: hash };
        fs.mkdirSync(path.dirname(memoryPath(id)), { recursive: true });
        fs.writeFileSync(memoryPath(id), JSON.stringify(memory));
        add(id, 'PROJECT_MEMORY_IMPACT_ASSESSED', memory, 'PASS');
    }

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-nested-parent-'));
        bundle = path.join(root, 'garda-agent-orchestrator'); reviews = path.join(bundle, 'runtime/reviews');
        fs.mkdirSync(reviews, { recursive: true });
        const config = path.join(bundle, 'live/config/workflow-config.json');
        fs.mkdirSync(path.dirname(config), { recursive: true });
        fs.writeFileSync(config, JSON.stringify({ full_suite_validation: { enabled: true, command } }));
        const frozenHash = createHash('sha256').update(fs.readFileSync(config)).digest('hex');
        const children: Record<string, string[]> = { [parent]: [nested, leaf], [nested]: [nestedLeaf, nestedLeafTwo] };
        fs.writeFileSync(path.join(root, 'TASK.md'), [
            '## Active Queue', '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
            ...[parent, nested, leaf, nestedLeaf, nestedLeafTwo].map(id => `| ${id} | DONE | P1 | audit | parent ${id} | test | 2026-10-16 | balanced | ${children[id] ? 'child tasks: ' + children[id].join(', ') : 'source leaf'} |`)
        ].join('\n') + '\n');
        writeParent(nested, children[nested]); writeParent(parent, children[parent]);
        const sourceHashes = new Map([leaf, nestedLeaf, nestedLeafTwo].map(id => {
            fs.writeFileSync(sourcePath(id), JSON.stringify({ task_id: id })); return [id, digest(sourcePath(id))];
        }));
        head = 'b'.repeat(40); leafReads = []; commandReads = []; missingLeaf = false;
        beforeRootCommand = () => {}; duringRootMemory = () => {};
        // Existing suites own native SOURCE, task-mode, memory and command authenticity.
        // This fixture keeps real graph decisions, timelines, artifact reads and orchestration.
        mock.method(sourceApi, 'readNativeChildSourceAcceptance', (_root: string, id: string) => {
            if (![leaf, nestedLeaf, nestedLeafTwo].includes(id) || missingLeaf) throw Error('Missing native leaf SOURCE: ' + id);
            assert.equal(digest(sourcePath(id)), sourceHashes.get(id), 'Native SOURCE proof artifact changed');
            leafReads.push(id);
            return { taskId: id, commitSha: head, treeSha: 'c'.repeat(40), parentCommitSha: null,
                artifactPath: sourcePath(id), artifactSha256: sourceHashes.get(id), postCommitAudit: {} };
        });
        mock.method(sourceApi, 'readNativeSourceCompositionProof', (_root: string, request: any) => {
            assert.equal(request.command, command); assert.equal(request.coverageContractSha256, null);
            assert.equal(digest(path.resolve(root, request.artifactPath)), request.artifactSha256, 'Native command proof artifact changed');
            commandReads.push(request.taskId); if (request.taskId === parent) beforeRootCommand();
            return { taskId: request.taskId, processStatus: 'PASSED' };
        });
        mock.method(modeApi, 'getTaskModeEvidence', (_root: string, id: string) => ({
            evidence_status: 'PASS', evidence_task_id: id, profile_policy_snapshot_status: 'PASS',
            timeline_profile_policy_snapshot_hash: hash,
            profile_policy_snapshot: { snapshot_hash: hash, config_hashes: { workflow_config: frozenHash } }
        }));
        mock.method(memoryApi, 'getProjectMemoryImpactLifecycleEvidence', (input: any) => {
            if (input.taskId === parent && commandReads.includes(parent)) duringRootMemory();
            return { required: true, evidence_status: 'CURRENT', artifact_path: memoryPath(input.taskId).replace(/\\/gu, '/') };
        });
        mock.method(gitApi, 'runGit', (_root: string, args: string[]) => args.includes('show')
            ? [head, 'c'.repeat(40), 'd'.repeat(40)].join('\n') : head);
        mock.method(wipApi, 'readAuthenticatedSplitRequiredWipManifestSnapshot', (_root: string, file: string) => ({
            manifest: JSON.parse(fs.readFileSync(file, 'utf8')), sha256: digest(file)
        }));
        mock.method(wipFilesApi, 'validateManifestFileReferences', () => []);
        mock.method(wipFilesApi, 'validateAdvancedManifestBlobs', () => []);
    });
    afterEach(() => { mock.restoreAll(); fs.rmSync(root, { recursive: true, force: true }); });

    it('qualifies a genuine nested aggregate while retaining actual leaf source identities', () => {
        const before = [timeline(parent), timeline(nested)].map(file => fs.readFileSync(file));
        const result = readNativeParentObligationProofs(root, parent)!;
        assert.equal(result.status, 'QUALIFIED', result.violations.join(' | '));
        assert.deepEqual(result.native.childSources.map(source => source.taskId), [nestedLeaf, nestedLeafTwo, leaf]);
        assert.deepEqual([...new Set(leafReads)], [nestedLeaf, nestedLeafTwo, leaf]);
        assert.deepEqual([...new Set(commandReads)], [nested, parent]);
        assert.ok(leafReads.length <= 6 && commandReads.length <= 3, 'Final checks must not recursively traverse the graph again');
        [timeline(parent), timeline(nested)].forEach((file, index) => assert.deepEqual(fs.readFileSync(file), before[index]));
    });

    it('retains each nested original obligation and ordinary leaf source requirement', () => {
        const original = fs.readFileSync(memoryPath(nested)); fs.unlinkSync(memoryPath(nested));
        assert.match(readNativeParentObligationProofs(root, parent)!.violations.join(' '), /memory/iu);
        fs.writeFileSync(memoryPath(nested), original);
        add(nested, 'INTERMEDIATE_COMMAND_RUN', { command }, 'FAIL');
        assert.match(readNativeParentObligationProofs(root, parent)!.violations.join(' '), /command/iu);
        add(nested, 'INTERMEDIATE_COMMAND_RUN', { command, artifact_path: commandPath(nested), artifact_sha256: digest(commandPath(nested)) }, 'PASSED');
        missingLeaf = true;
        assert.match(readNativeParentObligationProofs(root, parent)!.violations.join(' '), /Missing native leaf SOURCE/u);
    });

    it('rejects nested completion finalization and inconsistent explicit child graphs', () => {
        const lock = writeActiveCompletionLock(reviews, nested);
        assert.match(readNativeParentObligationProofs(root, parent)!.violations.join(' '), /finalization/iu);
        fs.rmSync(lock, { recursive: true });
        const queue = path.join(root, 'TASK.md');
        fs.writeFileSync(queue, fs.readFileSync(queue, 'utf8').replace('child tasks: ' + nestedLeaf, 'child tasks: ' + parent));
        assert.match(readNativeParentObligationProofs(root, parent)!.violations.join(' '), /graph|decomposition/iu);
    });

    it('rejects nested evidence changed after child qualification during the parent read', () => {
        beforeRootCommand = () => add(nested, 'INTERMEDIATE_COMMAND_RUN', { command }, 'FAIL');
        const result = readNativeParentObligationProofs(root, parent)!;
        assert.equal(result.status, 'BLOCKED'); assert.match(result.violations.join(' '), /changed|snapshot|timeline/iu);
    });

    it('rejects command, WIP and SOURCE artifacts removed after nested qualification', () => {
        for (const file of [commandPath(nested), wipPath(), sourcePath(nestedLeaf)]) {
            const before = fs.readFileSync(file);
            beforeRootCommand = () => fs.unlinkSync(file);
            const result = readNativeParentObligationProofs(root, parent)!;
            assert.equal(result.status, 'BLOCKED', file);
            assert.match(result.violations.join(' '), /artifact|proof|ENOENT|missing/iu);
            fs.writeFileSync(file, before);
        }
    });

    it('rejects a source epoch change after native child and command observations', () => {
        duringRootMemory = () => { head = 'e'.repeat(40); };
        const result = readNativeParentObligationProofs(root, parent)!;
        assert.equal(result.status, 'BLOCKED'); assert.match(result.violations.join(' '), /source|HEAD|epoch/iu);
    });
});
