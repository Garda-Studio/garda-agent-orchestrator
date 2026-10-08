import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import { assertContainedDestination, bindContainedDestination } from '../../core/contained-filesystem';
import { statFileIdentitySync } from '../../core/file-stat';
import { parseJsonText } from '../../core/json';
import { TASK_QUEUE_FILENAME } from '../../core/orchestration-constants';
import { isPlainRecord } from '../../core/records';
import { parseKnownReviewArtifactTaskId } from '../../core/task-ids';
import { parseCanonicalActiveTaskQueue } from '../../core/task-md-table';
import { readTaskQueueStatusToken } from '../../core/active-task-state';
import { inspectTaskEventFile } from '../../gate-runtime/task-events';
import { normalizeQualityChecklistAnswerInput } from '../quality-checklist';

const QUALITY_INPUT_SUFFIXES = [
    '-quality-checklist-answers.json',
    '-quality-checklist-answers.json.binding.json',
    '-quality-checklist-questions.md'
] as const;
const RUNTIME_PREFIX = 'garda-agent-orchestrator/runtime/';
const PROOF_LIMITS = Object.freeze({ owners: 16, inputBytes: 256 * 1024, artifactBytes: 1024 * 1024,
    queueBytes: 4 * 1024 * 1024, timelineBytes: 8 * 1024 * 1024 });
const TEMPLATE_METADATA_FIELDS = [
    'preflight_path', 'preflight_sha256', 'workflow_config_path', 'workflow_config_sha256',
    'effective_policy_sha256', 'active_rule_ids', 'active_rule_fingerprints'
] as const;
const TEMPLATE_FIELDS = new Set<string>([
    'schema_version', 'timestamp_utc', 'event_source', 'task_id', 'checklist_id', 'answers',
    ...TEMPLATE_METADATA_FIELDS
]);
const ANSWER_FIELDS = new Set(['rule_id', 'status', 'answer', 'evidence_files', 'actions_taken',
    'actions_required', 'trust_boundary_matrix']);

function inputVersion(stat: fs.BigIntStats): string {
    return [stat.dev, stat.ino, stat.mode, stat.nlink, stat.size, stat.mtimeNs, stat.ctimeNs,
        stat.birthtimeNs].join(':');
}

function bindProofInput(repoRoot: string, filePath: string, maximumBytes: number) {
    const binding = bindContainedDestination(repoRoot, filePath);
    if (binding.missingAt) throw new Error('Retained quality proof input is missing.');
    const before = statFileIdentitySync(filePath, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(maximumBytes)) {
        throw new Error('Retained quality proof requires a bounded ordinary file.');
    }
    const assertCurrent = () => {
        assertContainedDestination(binding);
        if (inputVersion(statFileIdentitySync(filePath, { bigint: true })) !== inputVersion(before)) {
            throw new Error('Retained quality proof input changed during inspection.');
        }
    };
    return { before, assertCurrent };
}

function readProofInput(repoRoot: string, filePath: string, maximumBytes: number) {
    const snapshot = bindProofInput(repoRoot, filePath, maximumBytes);
    // Refuse replacement FIFOs/symlinks before a read can block or leave the owning root.
    const descriptor = fs.openSync(filePath,
        fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW);
    try {
        snapshot.assertCurrent();
        if (inputVersion(fs.fstatSync(descriptor, { bigint: true })) !== inputVersion(snapshot.before)) {
            throw new Error('Retained quality proof descriptor identity changed.');
        }
        const buffer = Buffer.alloc(Number(snapshot.before.size) + 1);
        let count = 0;
        while (count < buffer.length) {
            const read = fs.readSync(descriptor, buffer, count, buffer.length - count, null);
            if (!read) break;
            count += read;
        }
        snapshot.assertCurrent();
        if (BigInt(count) !== snapshot.before.size
            || inputVersion(fs.fstatSync(descriptor, { bigint: true })) !== inputVersion(snapshot.before)) {
            throw new Error('Retained quality proof bytes changed during inspection.');
        }
        const bytes = buffer.subarray(0, count);
        return { bytes, sha256: createHash('sha256').update(bytes).digest('hex'),
            assertCurrent: snapshot.assertCurrent };
    } finally {
        fs.closeSync(descriptor);
    }
}

function parseProofRecord(bytes: Buffer): Record<string, unknown> {
    const value = parseJsonText(bytes.toString('utf8'), 'Retained quality proof');
    if (!isPlainRecord(value)) throw new Error('Retained quality proof must be an object.');
    return value;
}

function consumedAnswers(value: unknown): unknown[] | null {
    if (!Array.isArray(value)) return null;
    const answers: unknown[] = [];
    for (const answer of value) {
        if (!isPlainRecord(answer) || Object.keys(answer).some(key => !ANSWER_FIELDS.has(key))
            || typeof answer.rule_id !== 'string' || typeof answer.status !== 'string'
            || typeof answer.answer !== 'string') return null;
        const arrays = ['evidence_files', 'actions_taken', 'actions_required'] as const;
        if (arrays.some(key => answer[key] !== undefined
            && (!Array.isArray(answer[key]) || !(answer[key] as unknown[])
                .every(entry => typeof entry === 'string')))) return null;
        const consumed = normalizeQualityChecklistAnswerInput(answer);
        if (!consumed) return null;
        answers.push(consumed);
    }
    return answers;
}

function readCompletedQualityEvents(repoRoot: string, taskId: string) {
    const filePath = path.join(repoRoot, RUNTIME_PREFIX, 'task-events', `${taskId}.jsonl`);
    const timeline = bindProofInput(repoRoot, filePath, PROOF_LIMITS.timelineBytes);
    let binding: Record<string, unknown> | null = null;
    let quality: Record<string, unknown> | null = null;
    let completed = false;
    let done = false;
    const inspection = inspectTaskEventFile(filePath, taskId, { onIntegrityEvent: event => {
        const details = isPlainRecord(event.details) ? event.details : {};
        if (event.event_type === 'TASK_MODE_ENTERED'
            || event.event_type === 'PREFLIGHT_CLASSIFIED'
            || String(event.event_type).includes('CYCLE_RESTART')) {
            completed = false;
            done = false;
            quality = null;
        }
        if (event.event_type === 'QUALITY_CHECKLIST_ANSWERS_TEMPLATE_BINDING_RECORDED') {
            binding = event.actor === 'gate' ? details : null;
            completed = false;
            done = false;
        }
        if (event.event_type === 'QUALITY_CHECKLIST_RECORDED') {
            quality = event.actor === 'gate' && (event.outcome === 'PASS' || event.outcome === 'WARN')
                ? details : null;
            completed = false;
            done = false;
        }
        if (event.event_type === 'STATUS_CHANGED') {
            done = (event.actor === 'gate' || event.actor === 'orchestrator')
                && details.new_status === 'DONE';
            if (!done) completed = false;
        }
        if (event.event_type === 'COMPLETION_GATE_PASSED') {
            completed = event.actor === 'gate' && event.outcome === 'PASS';
        }
    } });
    timeline.assertCurrent();
    if ((inspection.status !== 'PASS' && inspection.status !== 'PASS_WITH_LEGACY_PREFIX')
        || !completed || !done || !binding || !quality) return null;
    return { binding: binding as Record<string, unknown>, quality: quality as Record<string, unknown>,
        assertCurrent: timeline.assertCurrent };
}

function verifyCompletedTriplet(repoRoot: string, taskId: string, relativePaths: string[]) {
    const files = relativePaths.map(filePath => readProofInput(repoRoot,
        path.join(repoRoot, filePath), PROOF_LIMITS.inputBytes));
    const artifactPath = path.join(repoRoot, RUNTIME_PREFIX, 'reviews', `${taskId}-quality-checklist.json`);
    const artifactInput = readProofInput(repoRoot, artifactPath, PROOF_LIMITS.artifactBytes);
    const template = parseProofRecord(files[0].bytes);
    const binding = parseProofRecord(files[1].bytes);
    const artifact = parseProofRecord(artifactInput.bytes);
    const events = readCompletedQualityEvents(repoRoot, taskId);
    if (!events || template.schema_version !== 1 || binding.schema_version !== 1
        || artifact.schema_version !== 1 || template.event_source !== 'quality-checklist-answers-template'
        || binding.event_source !== 'quality-checklist-answers-template-binding'
        || artifact.event_source !== 'quality-checklist'
        || (artifact.status !== 'PASS' && artifact.status !== 'WARN')
        || artifact.outcome !== artifact.status || [template, binding, artifact]
            .some(value => value.task_id !== taskId || value.checklist_id !== 'optional_quality_checks')
        || typeof template.timestamp_utc !== 'string' || !Number.isFinite(Date.parse(template.timestamp_utc))
        || Object.keys(template).some(key => !TEMPLATE_FIELDS.has(key))) return null;
    const answersPath = path.join(repoRoot, relativePaths[0]).replace(/\\/g, '/');
    if (binding.answers_path !== answersPath || events.binding.answers_path !== answersPath
        || events.binding.binding_path !== `${answersPath}.binding.json`
        || events.binding.binding_sha256 !== files[1].sha256
        || events.binding.answers_template_policy_sha256 !== binding.answers_template_policy_sha256
        || events.quality.artifact_path !== artifactPath.replace(/\\/g, '/')
        || events.quality.artifact_hash !== artifactInput.sha256
        || events.quality.status !== artifact.status || events.quality.outcome !== artifact.outcome
        || events.quality.preflight_sha256 !== artifact.preflight_sha256
        || events.quality.checklist_id !== artifact.checklist_id) return null;
    if (TEMPLATE_METADATA_FIELDS.some(key => !isDeepStrictEqual(template[key], binding[key]))
        || ['preflight_path', 'preflight_sha256', 'workflow_config_path', 'workflow_config_sha256',
            'effective_policy_sha256'].some(key => !isDeepStrictEqual(binding[key], artifact[key]))
        || !isDeepStrictEqual(events.binding.active_rule_ids, binding.active_rule_ids)
        || !Array.isArray(artifact.rules) || !Array.isArray(artifact.answers)) return null;
    const rules = artifact.rules;
    if (rules.some(rule => !isPlainRecord(rule))) return null;
    const activeRules = (rules as Record<string, unknown>[])
        .filter(rule => rule.scope_applicability === 'active');
    const activeIds = activeRules.map(rule => rule.id);
    const answers = consumedAnswers(template.answers);
    if (!answers || !isDeepStrictEqual(activeIds, binding.active_rule_ids)
        || !isDeepStrictEqual(answers, artifact.answers)) return null;
    const questions = [`# Active quality-checklist questions for ${taskId}`, '',
        ...activeRules.map(rule => `- ${rule.id}: ${String(rule.prompt || '').trim()}`)].join('\n') + '\n';
    if (files[2].bytes.toString('utf8') !== questions) return null;
    const assertCurrent = () => {
        for (const file of [...files, artifactInput]) file.assertCurrent();
        events.assertCurrent();
    };
    assertCurrent();
    return assertCurrent;
}

/** Retention proof only: it grants no fresh gate/review/commit authority and never mutates inputs. */
export function collectRetainedCompletedQualityInputs(
    repoRoot: string, parentTaskId: string, inventory: readonly string[], declaredScope: ReadonlySet<string>
): Set<string> {
    const retained = new Set<string>();
    const owners = new Set<string>();
    for (const filePath of inventory) {
        if (!filePath.startsWith(`${RUNTIME_PREFIX}tmp/`) || declaredScope.has(filePath)) continue;
        const taskId = parseKnownReviewArtifactTaskId(path.posix.basename(filePath), QUALITY_INPUT_SUFFIXES);
        if (taskId?.startsWith(`${parentTaskId}-`)) owners.add(taskId);
    }
    if (!owners.size || owners.size > PROOF_LIMITS.owners) return retained;
    const queue = readProofInput(repoRoot, path.join(repoRoot, TASK_QUEUE_FILENAME), PROOF_LIMITS.queueBytes);
    const parsedQueue = parseCanonicalActiveTaskQueue(queue.bytes.toString('utf8'));
    if (!parsedQueue.found) return retained;
    const inventorySet = new Set(inventory);
    const proofs: Array<() => void> = [];
    for (const taskId of owners) {
        const rows = parsedQueue.rows.filter(row => row.taskId === taskId);
        const paths = QUALITY_INPUT_SUFFIXES.map(suffix => `${RUNTIME_PREFIX}tmp/${taskId}${suffix}`);
        if (rows.length !== 1 || readTaskQueueStatusToken(rows[0].status) !== 'DONE'
            || paths.some(filePath => declaredScope.has(filePath) || !inventorySet.has(filePath))) continue;
        try {
            const proof = verifyCompletedTriplet(repoRoot, taskId, paths);
            if (!proof) continue;
            proofs.push(proof);
            paths.forEach(filePath => retained.add(filePath));
        } catch {
            // Missing, foreign, modified or uncertain evidence stays in guarded WIP inventory.
        }
    }
    queue.assertCurrent();
    proofs.forEach(assertCurrent => assertCurrent());
    return retained;
}
