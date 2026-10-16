import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { runGit } from '../../core/git-helpers';
import { readTransactionBytes } from '../../core/file-transaction-journal';
import { isPlainRecord } from '../../core/records';
import { joinOrchestratorPath } from '../../core/orchestrator-paths';
import { TASK_QUEUE_FILENAME } from '../../core/orchestration-constants';
import { resolveWorkflowConfigPath } from '../../core/full-suite-validation-config';
import { assertValidTaskId, inspectTaskEventFile, readTaskTimelineJsonlEntries, withTaskTimelineReadSnapshot } from '../../gate-runtime/task-events';
import { captureTaskTimelineReadSnapshotSha256, assertTaskTimelineReadSnapshotCurrent } from '../../gate-runtime/timeline/task-timeline-read-snapshot';
import { getProjectMemoryImpactLifecycleEvidence } from '../project-memory-impact/project-memory-impact';
import { readAuthenticatedSplitRequiredWipManifestSnapshot } from '../split-required/split-required-wip-runtime-handoff-contracts';
import { resolveWipRoot } from '../split-required/split-required-wip-contracts';
import { validateAdvancedManifestBlobs, validateManifestFileReferences } from '../split-required/split-required-wip-restore-plan';
import { readNativeDecomposedParentFacts, type NativeDecomposedParentFacts } from './task-audit-summary-lifecycle';
import { readNativeSourceCompositionProof, readParentAuditProofRecord } from './task-audit-summary-decomposed-parent-proofs';
import { getTaskModeEvidence } from '../task-mode/task-mode-evidence';
import type { DecomposedParentRequiredProof } from './task-audit-summary-types';

type Event = Readonly<Record<string, unknown>>;
const ORIGINAL_SUITE_EVENTS = new Set(['FULL_SUITE_VALIDATION_PASSED', 'FULL_SUITE_VALIDATION_WARNED', 'FULL_SUITE_VALIDATION_FAILED']);
export interface NativeParentObligationProofs {
    status: 'QUALIFIED' | 'BLOCKED';
    native: NativeDecomposedParentFacts;
    qualifiedProofs: DecomposedParentRequiredProof[];
    violations: string[];
}

function sequence(event: Event): number {
    return isPlainRecord(event.integrity) ? Number(event.integrity.task_sequence) : 0;
}

function readMemoryRecord(root: string, file: string): Record<string, unknown> {
    const nativePath = path.resolve(root, file);
    const bytes = readTransactionBytes(root, nativePath);
    if (!bytes) throw new Error('Original parent memory artifact is missing.');
    return readParentAuditProofRecord(root, nativePath, createHash('sha256').update(bytes).digest('hex'));
}

function readCleanOriginalPolicy(root: string, taskId: string, original: Event[]) {
    const entry = [...original].reverse().find(event => event.event_type === 'TASK_MODE_ENTERED');
    const preflight = [...original].reverse().find(event => event.event_type === 'PREFLIGHT_CLASSIFIED');
    const details = preflight?.details, entered = entry?.details;
    if (!entry || entry.outcome !== 'PASS' || !preflight || sequence(entry) >= sequence(preflight)
        || !isPlainRecord(entered) || entered.dirty_workspace_baseline_count !== 0
        || !isPlainRecord(details) || details.changed_files_count !== 0 || details.changed_lines_total !== 0
        || !isPlainRecord(details.zero_diff_guard) || details.zero_diff_guard.zero_diff_detected !== true
        || details.zero_diff_guard.status !== 'BASELINE_ONLY'
        || original.some(event => event.event_type === 'IMPLEMENTATION_STARTED')) {
        throw new Error('Original parent WIP requires a capture or verified native clean pre-implementation scope.');
    }
    const mode = getTaskModeEvidence(root, taskId);
    if (mode.evidence_status !== 'PASS' || mode.evidence_task_id !== taskId
        || mode.profile_policy_snapshot_status !== 'PASS' || !mode.profile_policy_snapshot
        || mode.timeline_profile_policy_snapshot_hash !== entered.profile_policy_snapshot_hash
        || mode.profile_policy_snapshot.snapshot_hash !== entered.profile_policy_snapshot_hash) {
        throw new Error('Original clean parent entry and frozen policy binding are invalid.');
    }
    return mode.profile_policy_snapshot;
}

function readUnexecutedOriginalCommand(root: string, taskId: string, original: Event[]): Record<string, unknown> {
    let policy: ReturnType<typeof readCleanOriginalPolicy>;
    try { policy = readCleanOriginalPolicy(root, taskId, original); }
    catch (error: unknown) {
        throw new Error('Original parent command and coverage contract are missing: '
            + (error instanceof Error ? error.message : String(error)));
    }
    const frozenHash = policy.config_hashes.workflow_config;
    if (!frozenHash) throw new Error('Original parent frozen workflow declaration is missing.');
    const config = readParentAuditProofRecord(root, resolveWorkflowConfigPath(root), frozenHash);
    const suite = config.full_suite_validation;
    if (!isPlainRecord(suite) || suite.enabled !== true || typeof suite.command !== 'string' || !suite.command.trim()) {
        throw new Error('Original parent frozen full-suite command declaration is missing or disabled.');
    }
    // A declaration selects the required current proof; it is not an old execution event.
    return { command: suite.command.trim(), coverage_contract_sha256: null };
}

function qualifyWip(root: string, taskId: string, original: Event[]): void {
    const captures = original.filter(event => event.event_type === 'SPLIT_REQUIRED_WIP_CAPTURED');
    if (captures.length === 0) { readCleanOriginalPolicy(root, taskId, original); return; }
    for (const event of captures) {
        const details = event.details;
        if (!isPlainRecord(details) || typeof details.manifest_path !== 'string') throw new Error('Native WIP capture identity is missing.');
        const file = path.resolve(root, details.manifest_path), wipRoot = resolveWipRoot(root, taskId);
        const snapshot = readAuthenticatedSplitRequiredWipManifestSnapshot(root, file, wipRoot), manifest = snapshot.manifest;
        if (snapshot.sha256 !== details.manifest_sha256 || manifest.task_id !== taskId || manifest.status !== 'suspended'
            || manifest.schema_version !== 1 || !Array.isArray(manifest.tracked_files) || !Array.isArray(manifest.untracked_files)) {
            throw new Error('Original parent WIP identity or captured hash differs.');
        }
        const violations = [...validateManifestFileReferences(root, manifest), ...validateAdvancedManifestBlobs(root, manifest, manifest.tracked_files)];
        if (violations.length) throw new Error('Original parent WIP bytes are invalid: ' + violations.join(' | '));
        if (readAuthenticatedSplitRequiredWipManifestSnapshot(root, file, wipRoot).sha256 !== snapshot.sha256) {
            throw new Error('Original parent WIP changed during qualification.');
        }
    }
}

function qualifyMemory(root: string, taskId: string, events: Event[], completionSequence: number): void {
    const preflight = joinOrchestratorPath(root, 'runtime/reviews/' + taskId + '-preflight.json');
    if (!readTransactionBytes(root, preflight)) throw new Error('Original parent preflight is missing for memory qualification.');
    const evidence = getProjectMemoryImpactLifecycleEvidence({ repoRoot: root, taskId, preflightPath: preflight });
    const event = [...events].reverse().find(item => item.event_type === 'PROJECT_MEMORY_IMPACT_ASSESSED');
    if (evidence.evidence_status !== 'CURRENT' || !event || event.outcome !== 'PASS' || sequence(event) <= completionSequence) {
        throw new Error('Original parent memory evidence is missing, stale or not natively assessed after child completion.');
    }
    const record = readMemoryRecord(root, evidence.artifact_path);
    if (record.task_id !== taskId || !isDeepStrictEqual(record, event.details)) throw new Error('Native parent memory artifact and event differ.');
    const current = getProjectMemoryImpactLifecycleEvidence({ repoRoot: root, taskId, preflightPath: preflight });
    if (current.evidence_status !== 'CURRENT' || !isDeepStrictEqual(current, evidence)
        || !isDeepStrictEqual(readMemoryRecord(root, evidence.artifact_path), record)) {
        throw new Error('Original parent memory changed during qualification.');
    }
}

function qualifyCommands(root: string, taskId: string, original: Event[], events: Event[], completionSequence: number): void {
    const contracts = original.filter(event => ORIGINAL_SUITE_EVENTS.has(String(event.event_type)))
        .map(event => event.details);
    if (contracts.length === 0) contracts.push(readUnexecutedOriginalCommand(root, taskId, original));
    const sourceFields = runGit(root, ['--no-replace-objects', 'show', '--no-patch', '--format=%H%n%T%n%P', 'HEAD'], { timeoutMs: 10000, maxBuffer: 4096 }).trim().split(/\r?\n/u);
    const source = { commitSha: sourceFields[0], treeSha: sourceFields[1], parentCommitSha: sourceFields[2]?.split(' ')[0] || null };
    const checked = new Set<string>();
    for (const details of contracts) {
        if (!isPlainRecord(details) || typeof details.command !== 'string' || !details.command.trim()) throw new Error('Original parent command identity is missing.');
        const command = details.command, coverage = details.coverage_contract_sha256 ?? null;
        if (coverage !== null && typeof coverage !== 'string') throw new Error('Original command coverage identity is invalid.');
        const key = JSON.stringify([command, coverage]);
        if (checked.has(key)) continue;
        const latest = [...events].reverse().find(item => item.event_type === 'INTERMEDIATE_COMMAND_RUN'
            && isPlainRecord(item.details) && item.details.command === command);
        const proof = latest?.details;
        if (!latest || !['PASS', 'PASSED'].includes(String(latest.outcome)) || sequence(latest) <= completionSequence || !isPlainRecord(proof)
            || typeof proof.artifact_path !== 'string' || typeof proof.artifact_sha256 !== 'string') {
            throw new Error('Original parent command has no successful post-completion native composition proof.');
        }
        readNativeSourceCompositionProof(root, { taskId, command, coverageContractSha256: coverage,
            artifactPath: proof.artifact_path, artifactSha256: proof.artifact_sha256, source });
        checked.add(key);
    }
}

/** Qualified observations are not parent acceptance and never mutate original evidence. */
export function readNativeParentObligationProofs(repoRoot: string, taskId: string): NativeParentObligationProofs | null {
    const root = path.resolve(repoRoot), id = assertValidTaskId(taskId), eventsRoot = joinOrchestratorPath(root, 'runtime/task-events');
    return withTaskTimelineReadSnapshot(eventsRoot, id, () => {
        const files = [path.join(root, TASK_QUEUE_FILENAME), ...['strict-decomposition-decision', 'preflight'].map(kind => joinOrchestratorPath(root, 'runtime/reviews/' + id + '-' + kind + '.json'))];
        const inputs = files.map(file => readTransactionBytes(root, file));
        const native = readNativeDecomposedParentFacts(root, id);
        if (!native) return null;
        const result: NativeParentObligationProofs = { status: 'BLOCKED', native, qualifiedProofs: [], violations: [...native.requirements.violations] };
        if (native.requirements.status !== 'REQUIRES_PROOF') return result;
        const qualify = (proof: DecomposedParentRequiredProof, action: () => void) => {
            try { action(); result.qualifiedProofs.push(proof); }
            catch (error: unknown) { result.violations.push(error instanceof Error ? error.message : String(error)); }
        };
        try {
            const timeline = path.join(eventsRoot, id + '.jsonl'), inspection = inspectTaskEventFile(timeline, id);
            if (!['PASS', 'PASS_WITH_LEGACY_PREFIX'].includes(inspection.status) || inspection.violations.length) throw new Error('Original parent timeline is not intact.');
            const snapshot = captureTaskTimelineReadSnapshotSha256(timeline);
            const events = readTaskTimelineJsonlEntries(timeline).map(entry => entry.record).filter(isPlainRecord);
            const original = events.filter(event => sequence(event) <= native.facts.decomposition!.sequence);
            const completion = native.facts.completion!.sequence;
            const needsDeclaration = native.requirements.requiredProofs.includes('full-suite-composition')
                && !original.some(event => ORIGINAL_SUITE_EVENTS.has(String(event.event_type)));
            const additional = needsDeclaration || !original.some(event => event.event_type === 'SPLIT_REQUIRED_WIP_CAPTURED')
                ? [joinOrchestratorPath(root, 'runtime/reviews/' + id + '-task-mode.json')] : [];
            if (needsDeclaration) additional.push(resolveWorkflowConfigPath(root));
            for (const file of additional) { files.push(file); inputs.push(readTransactionBytes(root, file)); }
            result.qualifiedProofs.push('authenticated-decomposition', 'source-qualified-child-acceptance');
            qualify('preserved-parent-wip', () => qualifyWip(root, id, original));
            if (native.requirements.requiredProofs.includes('full-suite-composition')) qualify('full-suite-composition', () => qualifyCommands(root, id, original, events, completion));
            if (native.requirements.requiredProofs.includes('parent-memory-impact')) qualify('parent-memory-impact', () => qualifyMemory(root, id, events, completion));
            if (native.requirements.requiredProofs.includes('historical-failure-resolution')) qualify('historical-failure-resolution', () => {
                for (const failure of native.requirements.historicalFailures) {
                    const proof = failure === 'full-suite-validation' ? 'full-suite-composition' : failure === 'project-memory-impact' ? 'parent-memory-impact' : null;
                    if (!proof || !result.qualifiedProofs.includes(proof)) throw new Error('Unresolved original historical failure: ' + failure);
                }
            });
            files.forEach((file, i) => {
                if (!isDeepStrictEqual(readTransactionBytes(root, file), inputs[i])) throw new Error('Original parent inputs changed during qualification.');
            });
            assertTaskTimelineReadSnapshotCurrent(timeline, snapshot);
            if (result.violations.length === 0 && native.requirements.requiredProofs.every(proof => result.qualifiedProofs.includes(proof))) result.status = 'QUALIFIED';
        } catch (error: unknown) { result.violations.push(error instanceof Error ? error.message : String(error)); }
        return result;
    });
}
