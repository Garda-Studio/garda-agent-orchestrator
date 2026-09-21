import * as fs from 'node:fs';
import * as path from 'node:path';

import { writeFileAtomically } from '../../core/filesystem';
import { joinOrchestratorPath, resolvePathInsideRepo } from '../../core/orchestrator-paths';
import { isCanonicalTaskId } from '../../core/task-ids';
import { fileSha256, stringSha256 } from '../../gate-runtime/hash';
import {
    isReviewArtifactReadBarrierParticipant,
    readReviewArtifactFileSnapshot,
    withReviewArtifactLock
} from '../../gate-runtime/review-artifacts';
import {
    appendTaskEvent,
    inspectTaskEventFile,
    taskEventAppendHasBlockingFailure
} from '../../gate-runtime/task-events';
import { compareSemanticCycleSnapshots } from './semantic-cycle-comparison';
import type { SemanticCycleReviewLaneBinding } from './semantic-cycle-contract-types';
import { serializeSemanticCycleValue } from './semantic-cycle-snapshot';
import {
    SEMANTIC_CYCLE_REBIND_ARTIFACT_CLASSES,
    SEMANTIC_CYCLE_REBIND_TRANSACTION_CONTRACT_ID,
    SEMANTIC_CYCLE_REBIND_TRANSACTION_SCHEMA_VERSION,
    type SemanticCycleLifecyclePosition,
    type SemanticCycleRebindArtifactClass,
    type SemanticCycleRebindArtifactInput,
    type SemanticCycleRebindAudit,
    type SemanticCycleRebindInvalidationCode,
    type SemanticCycleRebindManifest,
    type SemanticCycleRebindManifestPayload,
    type SemanticCycleRebindManifestValidationResult,
    type SemanticCycleRebindTransactionOptions,
    type SemanticCycleRebindTransactionResult,
    type SemanticCycleReboundArtifact
} from './semantic-cycle-transaction-types';

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const REVIEW_TYPE_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const REVIEW_ARTIFACT_CLASSES = new Set<SemanticCycleRebindArtifactClass>([
    'review_context',
    'findings_disposition',
    'review_receipt',
    'reviewer_dependency'
]);

interface ArtifactAssessment {
    artifacts: SemanticCycleRebindArtifactInput[];
    classCounts: Record<SemanticCycleRebindArtifactClass, number>;
    verifiedCount: number;
    violations: string[];
}

interface LifecycleAuthorityAssessment {
    authoritySha256: string | null;
    violations: string[];
}

export interface SemanticCycleCommitEventBindingAssessment {
    status: 'VALID' | 'MISSING' | 'INVALID';
    violations: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function sha256Value(value: unknown): string {
    return stringSha256(serializeSemanticCycleValue(value)) || '';
}

function compareCanonicalStrings(left: string, right: string): number {
    if (left === right) {
        return 0;
    }
    return left < right ? -1 : 1;
}

function createClassCounts(): Record<SemanticCycleRebindArtifactClass, number> {
    return {
        compile: 0,
        full_suite: 0,
        review_context: 0,
        findings_disposition: 0,
        review_receipt: 0,
        reviewer_dependency: 0
    };
}

function artifactKey(artifact: SemanticCycleRebindArtifactInput): string {
    return `${artifact.artifact_class}:${artifact.review_type || ''}`;
}

function normalizeArtifacts(
    artifacts: readonly SemanticCycleRebindArtifactInput[]
): SemanticCycleRebindArtifactInput[] {
    return artifacts
        .map((artifact) => ({ ...artifact }))
        .sort((left, right) => compareCanonicalStrings(artifactKey(left), artifactKey(right)));
}

function normalizeRepoRelativePath(repoRoot: string, absolutePath: string): string {
    return path.relative(repoRoot, absolutePath).replace(/\\/gu, '/');
}

function sameResolvedPath(left: string, right: string): boolean {
    const canonicalize = (value: string): string => {
        const resolved = path.resolve(value);
        try {
            return fs.realpathSync.native(resolved);
        } catch {
            return resolved;
        }
    };
    return canonicalize(left) === canonicalize(right);
}

function taskEventPrefixSha256(filePath: string, targetSequence: number): string | null {
    try {
        const content = fs.readFileSync(filePath, 'utf8');
        const lines = content.match(/.*(?:\r?\n|$)/gu) || [];
        let prefix = '';
        for (const line of lines) {
            if (!line.trim()) {
                continue;
            }
            prefix += line;
            const event = JSON.parse(line) as Record<string, unknown>;
            const integrity = isRecord(event.integrity) ? event.integrity : null;
            if (Number(integrity?.task_sequence) === targetSequence) {
                return stringSha256(prefix);
            }
        }
    } catch {
        // Integrity validation reports the authoritative parse failure separately.
    }
    return null;
}

export function assessSemanticCycleCommitEventBinding(params: {
    repo_root: string;
    task_id: string;
    manifest_path: string;
    task_events_path: string;
    manifest: SemanticCycleRebindManifest;
}): SemanticCycleCommitEventBindingAssessment {
    const expectedSequence = params.manifest.target_position.task_event_sequence + 1;
    const candidates: Record<string, unknown>[] = [];
    const inspection = inspectTaskEventFile(params.task_events_path, params.task_id, {
        onIntegrityEvent: (event) => {
            const integrity = isRecord(event.integrity) ? event.integrity : null;
            if (Number(integrity?.task_sequence) === expectedSequence) {
                candidates.push(event as Record<string, unknown>);
            }
        }
    });
    if (!['PASS', 'PASS_WITH_LEGACY_PREFIX'].includes(inspection.status)) {
        return {
            status: 'INVALID',
            violations: [`Semantic-cycle commit event authority is unverifiable: ${inspection.violations.join(' ')}`]
        };
    }
    const candidate = candidates[0];
    if (!candidate) {
        return {
            status: 'MISSING',
            violations: [`Semantic-cycle transaction commit event is missing at task-event seq ${expectedSequence}.`]
        };
    }
    let resolvedManifestPath: string | null = null;
    try {
        resolvedManifestPath = resolvePathInsideRepo(params.manifest_path, params.repo_root, {
            allowMissing: false,
            enforceInside: true
        });
    } catch {
        return {
            status: 'INVALID',
            violations: ['Semantic-cycle commit event manifest path is not canonically bound.']
        };
    }
    const details = isRecord(candidate.details) ? candidate.details : null;
    const expectedRelativePath = resolvedManifestPath
        ? normalizeRepoRelativePath(params.repo_root, resolvedManifestPath)
        : '';
    const matches = (
        String(candidate.event_type || '').trim().toUpperCase() === 'SEMANTIC_CYCLE_REBIND_COMMITTED'
        && String(candidate.outcome || '').trim().toUpperCase() === 'PASS'
        && details?.transaction_id === params.manifest.transaction_id
        && details?.transaction_sha256 === params.manifest.transaction_sha256
        && details?.manifest_path === expectedRelativePath
        && details?.manifest_sha256 === fileSha256(resolvedManifestPath || '')
    );
    return matches
        ? { status: 'VALID', violations: [] }
        : {
            status: 'INVALID',
            violations: ['Semantic-cycle transaction commit event does not bind the current manifest bytes.']
        };
}

function appendSemanticCycleCommitEvent(
    options: SemanticCycleRebindTransactionOptions,
    manifest: SemanticCycleRebindManifest,
    manifestPath: string
): boolean {
    const manifestSha256 = fileSha256(manifestPath);
    if (!manifestSha256) {
        throw new Error('Committed semantic-cycle manifest is unavailable for task-event binding.');
    }
    const result = appendTaskEvent(
        options.repo_root,
        manifest.task_id || '',
        'SEMANTIC_CYCLE_REBIND_COMMITTED',
        'PASS',
        'Semantic-cycle rebind transaction committed.',
        {
            transaction_id: manifest.transaction_id,
            transaction_sha256: manifest.transaction_sha256,
            manifest_path: normalizeRepoRelativePath(options.repo_root, manifestPath),
            manifest_sha256: manifestSha256
        },
        {
            actor: 'gate',
            eventsRoot: path.dirname(options.task_events_path),
            passThru: true
        }
    );
    if (!result || (!result.canonical_committed && taskEventAppendHasBlockingFailure(result, false))) {
        throw new Error(
            `Semantic-cycle commit task-event append failed${
                result?.warnings.length ? `: ${result.warnings.join(' | ')}` : '.'
            }`
        );
    }
    return result.canonical_committed;
}

function assessLifecycleAuthority(options: SemanticCycleRebindTransactionOptions): LifecycleAuthorityAssessment {
    const violations: string[] = [];
    const taskId = options.authoritative_snapshot.task_id;
    if (!isCanonicalTaskId(taskId)) {
        return { authoritySha256: null, violations: ['Lifecycle authority requires a canonical task id.'] };
    }
    const snapshotPosition = options.authoritative_snapshot.lifecycle_position;
    if (
        !snapshotPosition
        || snapshotPosition.cycle_sha256 !== options.source_position.cycle_sha256
        || snapshotPosition.task_event_sequence !== options.source_position.task_event_sequence
    ) {
        violations.push(
            'source_position must exactly match the lifecycle position authenticated by the authoritative snapshot.'
        );
    }
    const canonicalPath = joinOrchestratorPath(
        options.repo_root,
        path.join('runtime', 'task-events', `${taskId}.jsonl`)
    );
    let resolvedPath: string | null = null;
    try {
        resolvedPath = resolvePathInsideRepo(options.task_events_path, options.repo_root, {
            allowMissing: false,
            enforceInside: true
        });
    } catch (error: unknown) {
        violations.push(
            `Lifecycle authority path is invalid: ${error instanceof Error ? error.message : String(error)}`
        );
    }
    if (!resolvedPath || !sameResolvedPath(resolvedPath, canonicalPath)) {
        violations.push('Lifecycle authority must use the canonical task-events path for the task.');
        return { authoritySha256: resolvedPath ? fileSha256(resolvedPath) : null, violations };
    }

    const eventHashes = new Map<number, string>();
    const inspection = inspectTaskEventFile(resolvedPath, taskId, {
        onIntegrityEvent: (event) => {
            const integrity = isRecord(event.integrity) ? event.integrity : null;
            if (
                integrity
                && Number.isInteger(integrity.task_sequence)
                && SHA256_PATTERN.test(String(integrity.event_sha256 || ''))
            ) {
                eventHashes.set(Number(integrity.task_sequence), String(integrity.event_sha256));
            }
        }
    });
    if (!['PASS', 'PASS_WITH_LEGACY_PREFIX'].includes(inspection.status)) {
        violations.push(`Lifecycle authority integrity validation failed: ${inspection.violations.join(' ')}`);
    }
    const sourceHash = eventHashes.get(options.source_position.task_event_sequence);
    const targetHash = eventHashes.get(options.target_position.task_event_sequence);
    if (sourceHash !== options.source_position.cycle_sha256) {
        violations.push('source_position does not match its authenticated task-event chain anchor.');
    }
    if (targetHash !== options.target_position.cycle_sha256) {
        violations.push('target_position does not match its authenticated task-event chain anchor.');
    }
    const targetSequence = options.target_position.task_event_sequence;
    const expectedCommittedTail = targetSequence + 1;
    if (inspection.last_integrity_sequence !== targetSequence) {
        const manifestPath = joinOrchestratorPath(
            options.repo_root,
            path.join('runtime', 'reviews', `${taskId}-semantic-cycle-rebind.json`)
        );
        const existing = parseManifestFile(manifestPath, { allowPending: true });
        const binding = existing.manifest
            ? assessSemanticCycleCommitEventBinding({
                repo_root: options.repo_root,
                task_id: taskId,
                manifest_path: manifestPath,
                task_events_path: resolvedPath,
                manifest: existing.manifest
            })
            : null;
        if (inspection.last_integrity_sequence !== expectedCommittedTail || binding?.status !== 'VALID') {
            violations.push(
                'Lifecycle authority target_position must identify the current authenticated task-event chain tail.'
            );
        }
    }
    return {
        authoritySha256: taskEventPrefixSha256(resolvedPath, targetSequence),
        violations
    };
}

function validateLifecyclePosition(
    position: SemanticCycleLifecyclePosition,
    label: string,
    violations: string[]
): void {
    if (!position || !SHA256_PATTERN.test(String(position.cycle_sha256 || ''))) {
        violations.push(`${label}.cycle_sha256 must be a lowercase SHA-256 hex string.`);
    }
    if (!Number.isInteger(position?.task_event_sequence) || position.task_event_sequence < 0) {
        violations.push(`${label}.task_event_sequence must be a non-negative integer.`);
    }
}

function expectedArtifactSha256(
    artifact: SemanticCycleRebindArtifactInput,
    authoritativeBindings: SemanticCycleRebindTransactionOptions['authoritative_snapshot']['bindings'],
    lanes: ReadonlyMap<string, SemanticCycleReviewLaneBinding>
): string | null {
    if (artifact.artifact_class === 'compile') {
        return authoritativeBindings.compile_evidence;
    }
    if (artifact.artifact_class === 'full_suite') {
        return authoritativeBindings.full_suite_evidence;
    }
    const lane = artifact.review_type ? lanes.get(artifact.review_type) : null;
    if (!lane) {
        return null;
    }
    switch (artifact.artifact_class) {
        case 'review_context':
            return lane.context_sha256;
        case 'findings_disposition':
            return lane.findings_disposition_sha256;
        case 'review_receipt':
            return lane.receipt_sha256;
        case 'reviewer_dependency':
            return lane.dependency_state_sha256;
        default:
            return null;
    }
}

function expectedArtifactKeys(
    reviewTypes: readonly string[]
): Set<string> {
    const keys = new Set(['compile:', 'full_suite:']);
    for (const reviewType of reviewTypes) {
        for (const artifactClass of REVIEW_ARTIFACT_CLASSES) {
            keys.add(`${artifactClass}:${reviewType}`);
        }
    }
    return keys;
}

function assessArtifacts(options: SemanticCycleRebindTransactionOptions): ArtifactAssessment {
    const violations: string[] = [];
    const classCounts = createClassCounts();
    const lanes = new Map(options.authoritative_snapshot.review_lanes.map((lane) => [lane.review_type, lane]));
    const reviewTypes = [...lanes.keys()].sort(compareCanonicalStrings);
    const expectedKeys = expectedArtifactKeys(reviewTypes);
    const seenKeys = new Set<string>();
    const normalized: SemanticCycleRebindArtifactInput[] = [];
    let verifiedCount = 0;

    for (const lane of lanes.values()) {
        if (!lane.accepted_receipt) {
            violations.push(`Review lane '${lane.review_type}' has no accepted receipt and cannot be rebound.`);
        }
    }

    for (const [index, input] of normalizeArtifacts(options.artifacts).entries()) {
        const label = `artifacts[${index}]`;
        if (!(SEMANTIC_CYCLE_REBIND_ARTIFACT_CLASSES as readonly string[]).includes(input.artifact_class)) {
            violations.push(`${label}.artifact_class is unsupported.`);
            continue;
        }
        classCounts[input.artifact_class] += 1;
        const reviewScoped = REVIEW_ARTIFACT_CLASSES.has(input.artifact_class);
        if (reviewScoped) {
            if (typeof input.review_type !== 'string' || !REVIEW_TYPE_PATTERN.test(input.review_type)) {
                violations.push(`${label}.review_type must identify a canonical review lane.`);
            }
        } else if (input.review_type !== null) {
            violations.push(`${label}.review_type must be null for ${input.artifact_class} evidence.`);
        }
        if (input.accepted !== true) {
            violations.push(`${label}.accepted must be true before evidence can be rebound.`);
        }
        if (!SHA256_PATTERN.test(String(input.source_sha256 || ''))) {
            violations.push(`${label}.source_sha256 must be a lowercase SHA-256 hex string.`);
        }
        const key = artifactKey(input);
        if (seenKeys.has(key)) {
            violations.push(`${label} duplicates artifact binding '${key}'.`);
        }
        seenKeys.add(key);

        const expectedSha256 = expectedArtifactSha256(input, options.authoritative_snapshot.bindings, lanes);
        if (!expectedSha256) {
            violations.push(`${label} does not map to an authenticated semantic snapshot binding.`);
        } else if (input.source_sha256 !== expectedSha256) {
            violations.push(
                `${label}.source_sha256 does not match the authenticated '${key}' snapshot binding.`
            );
        }

        let resolvedPath: string | null = null;
        try {
            resolvedPath = resolvePathInsideRepo(input.source_path, options.repo_root, {
                allowMissing: false,
                enforceInside: true
            });
        } catch (error: unknown) {
            violations.push(`${label}.source_path is invalid: ${error instanceof Error ? error.message : String(error)}`);
        }
        const actualSha256 = resolvedPath ? fileSha256(resolvedPath) : null;
        if (resolvedPath && actualSha256 !== input.source_sha256) {
            violations.push(
                `${label}.source_path content hash changed: expected ${input.source_sha256}, ` +
                `found ${actualSha256 || 'missing'}.`
            );
        }
        if (resolvedPath && actualSha256 === input.source_sha256 && expectedSha256 === input.source_sha256) {
            verifiedCount += 1;
        }
        normalized.push({
            ...input,
            source_path: resolvedPath
                ? normalizeRepoRelativePath(options.repo_root, resolvedPath)
                : String(input.source_path || '').replace(/\\/gu, '/')
        });
    }

    for (const key of expectedKeys) {
        if (!seenKeys.has(key)) {
            violations.push(`Required artifact binding '${key}' is missing.`);
        }
    }
    for (const key of seenKeys) {
        if (!expectedKeys.has(key)) {
            violations.push(`Artifact binding '${key}' is not present in the authenticated review lane set.`);
        }
    }
    return { artifacts: normalized, classCounts, verifiedCount, violations };
}

function buildRequestSha256(
    options: SemanticCycleRebindTransactionOptions,
    normalizedArtifacts: readonly SemanticCycleRebindArtifactInput[],
    lifecycleAuthoritySha256: string | null
): string {
    return sha256Value({
        authoritative_snapshot: options.authoritative_snapshot,
        candidate_snapshot: options.candidate_snapshot,
        comparison: options.comparison,
        current_runtime: options.current_runtime,
        source_position: options.source_position,
        target_position: options.target_position,
        lifecycle_authority_sha256: lifecycleAuthoritySha256,
        artifacts: normalizedArtifacts
    });
}

function manifestHashPayload(
    manifest: SemanticCycleRebindManifestPayload | SemanticCycleRebindManifest
): SemanticCycleRebindManifestPayload {
    return {
        schema_version: manifest.schema_version,
        contract_id: manifest.contract_id,
        transaction_id: manifest.transaction_id,
        request_sha256: manifest.request_sha256,
        status: manifest.status,
        task_id: manifest.task_id,
        created_at_utc: manifest.created_at_utc,
        source_position: { ...manifest.source_position },
        target_position: { ...manifest.target_position },
        comparison_decision_sha256: manifest.comparison_decision_sha256,
        authoritative_snapshot_sha256: manifest.authoritative_snapshot_sha256,
        candidate_snapshot_sha256: manifest.candidate_snapshot_sha256,
        lifecycle_authority_sha256: manifest.lifecycle_authority_sha256,
        artifacts: manifest.artifacts.map((artifact) => ({ ...artifact })),
        audit: {
            ...manifest.audit,
            artifact_class_counts: { ...manifest.audit.artifact_class_counts },
            invalidation_codes: [...manifest.audit.invalidation_codes],
            violations: [...manifest.audit.violations]
        }
    };
}

export function computeSemanticCycleRebindManifestSha256(
    manifest: SemanticCycleRebindManifestPayload | SemanticCycleRebindManifest
): string {
    return sha256Value(manifestHashPayload(manifest));
}

function buildManifest(params: {
    options: SemanticCycleRebindTransactionOptions;
    requestSha256: string;
    artifacts: readonly SemanticCycleRebindArtifactInput[];
    assessment: ArtifactAssessment;
    status: 'COMMITTED' | 'INVALIDATED';
    route: SemanticCycleRebindAudit['route'];
    invalidationCodes: readonly SemanticCycleRebindInvalidationCode[];
    violations: readonly string[];
    rollbackPerformed?: boolean;
    rollbackCompleted?: boolean;
    lifecycleAuthoritySha256: string | null;
}): SemanticCycleRebindManifest {
    const committed = params.status === 'COMMITTED';
    const artifacts: SemanticCycleReboundArtifact[] = committed
        ? params.artifacts.map((artifact) => ({
            ...artifact,
            rebound_cycle_sha256: params.options.target_position.cycle_sha256,
            rebound_task_event_sequence: params.options.target_position.task_event_sequence
        }))
        : [];
    const audit: SemanticCycleRebindAudit = {
        event: committed ? 'SEMANTIC_CYCLE_REBIND_COMMITTED' : 'SEMANTIC_CYCLE_REBIND_INVALIDATED',
        outcome: committed ? 'REUSED' : 'INVALIDATED',
        route: params.route,
        mutation_allowed: committed,
        comparison_decision_sha256: params.options.comparison.decision_sha256,
        authoritative_snapshot_sha256: params.options.authoritative_snapshot.snapshot_sha256 || null,
        candidate_snapshot_sha256: params.options.candidate_snapshot.snapshot_sha256 || null,
        lifecycle_authority_sha256: params.lifecycleAuthoritySha256,
        request_sha256: params.requestSha256,
        verified_artifact_count: params.assessment.verifiedCount,
        artifact_class_counts: { ...params.assessment.classCounts },
        invalidation_codes: [...params.invalidationCodes],
        violations: [...params.violations],
        rollback_performed: params.rollbackPerformed === true,
        rollback_completed: params.rollbackCompleted !== false
    };
    const payload: SemanticCycleRebindManifestPayload = {
        schema_version: SEMANTIC_CYCLE_REBIND_TRANSACTION_SCHEMA_VERSION,
        contract_id: SEMANTIC_CYCLE_REBIND_TRANSACTION_CONTRACT_ID,
        transaction_id: sha256Value({
            contract_id: SEMANTIC_CYCLE_REBIND_TRANSACTION_CONTRACT_ID,
            request_sha256: params.requestSha256
        }),
        request_sha256: params.requestSha256,
        status: params.status,
        task_id: isCanonicalTaskId(params.options.authoritative_snapshot.task_id)
            ? params.options.authoritative_snapshot.task_id
            : null,
        created_at_utc: params.options._testHooks?.now_utc?.() || new Date().toISOString(),
        source_position: { ...params.options.source_position },
        target_position: { ...params.options.target_position },
        comparison_decision_sha256: params.options.comparison.decision_sha256,
        authoritative_snapshot_sha256: params.options.authoritative_snapshot.snapshot_sha256 || null,
        candidate_snapshot_sha256: params.options.candidate_snapshot.snapshot_sha256 || null,
        lifecycle_authority_sha256: params.lifecycleAuthoritySha256,
        artifacts,
        audit
    };
    return {
        ...payload,
        transaction_sha256: computeSemanticCycleRebindManifestSha256(payload)
    };
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string, violations: string[]): void {
    const expectedSet = new Set(expected);
    const missing = expected.filter((key) => !Object.prototype.hasOwnProperty.call(value, key));
    const unexpected = Object.keys(value).filter((key) => !expectedSet.has(key));
    if (missing.length > 0) {
        violations.push(`${label} is missing field(s): ${missing.join(', ')}.`);
    }
    if (unexpected.length > 0) {
        violations.push(`${label} contains unsupported field(s): ${unexpected.join(', ')}.`);
    }
}

export function validateSemanticCycleRebindManifest(
    value: unknown
): SemanticCycleRebindManifestValidationResult {
    const violations: string[] = [];
    if (!isRecord(value)) {
        return { status: 'INVALID', manifest: null, violations: ['manifest must be an object.'] };
    }
    exactKeys(value, [
        'schema_version', 'contract_id', 'transaction_id', 'request_sha256', 'status', 'task_id',
        'created_at_utc', 'source_position', 'target_position', 'comparison_decision_sha256',
        'authoritative_snapshot_sha256', 'candidate_snapshot_sha256', 'lifecycle_authority_sha256',
        'artifacts', 'audit',
        'transaction_sha256'
    ], 'manifest', violations);
    if (value.schema_version !== SEMANTIC_CYCLE_REBIND_TRANSACTION_SCHEMA_VERSION) {
        violations.push(`manifest.schema_version must equal ${SEMANTIC_CYCLE_REBIND_TRANSACTION_SCHEMA_VERSION}.`);
    }
    if (value.contract_id !== SEMANTIC_CYCLE_REBIND_TRANSACTION_CONTRACT_ID) {
        violations.push(`manifest.contract_id must equal '${SEMANTIC_CYCLE_REBIND_TRANSACTION_CONTRACT_ID}'.`);
    }
    for (const key of [
        'transaction_id', 'request_sha256', 'comparison_decision_sha256', 'transaction_sha256'
    ] as const) {
        if (!SHA256_PATTERN.test(String(value[key] || ''))) {
            violations.push(`manifest.${key} must be a lowercase SHA-256 hex string.`);
        }
    }
    for (const key of [
        'authoritative_snapshot_sha256', 'candidate_snapshot_sha256', 'lifecycle_authority_sha256'
    ] as const) {
        if (value[key] !== null && !SHA256_PATTERN.test(String(value[key] || ''))) {
            violations.push(`manifest.${key} must be null or a lowercase SHA-256 hex string.`);
        }
    }
    if (!['COMMITTED', 'INVALIDATED'].includes(String(value.status || ''))) {
        violations.push('manifest.status must be COMMITTED or INVALIDATED.');
    }
    if (value.task_id !== null && !isCanonicalTaskId(value.task_id)) {
        violations.push('manifest.task_id must be null or canonical.');
    }
    if (
        typeof value.created_at_utc !== 'string'
        || Number.isNaN(Date.parse(value.created_at_utc))
        || new Date(value.created_at_utc).toISOString() !== value.created_at_utc
    ) {
        violations.push('manifest.created_at_utc must be a canonical ISO-8601 UTC timestamp.');
    }
    for (const [key, label] of [
        ['source_position', 'manifest.source_position'],
        ['target_position', 'manifest.target_position']
    ] as const) {
        if (!isRecord(value[key])) {
            violations.push(`${label} must be an object.`);
        } else {
            exactKeys(value[key], ['cycle_sha256', 'task_event_sequence'], label, violations);
            validateLifecyclePosition(value[key] as unknown as SemanticCycleLifecyclePosition, label, violations);
        }
    }
    const manifestArtifacts: SemanticCycleReboundArtifact[] = [];
    const manifestClassCounts = createClassCounts();
    const manifestArtifactKeys = new Set<string>();
    if (!Array.isArray(value.artifacts)) {
        violations.push('manifest.artifacts must be an array.');
    } else {
        value.artifacts.forEach((artifactValue, index) => {
            const label = `manifest.artifacts[${index}]`;
            if (!isRecord(artifactValue)) {
                violations.push(`${label} must be an object.`);
                return;
            }
            exactKeys(artifactValue, [
                'artifact_class', 'review_type', 'source_path', 'source_sha256', 'accepted',
                'rebound_cycle_sha256', 'rebound_task_event_sequence'
            ], label, violations);
            const artifactClass = String(artifactValue.artifact_class || '') as SemanticCycleRebindArtifactClass;
            if (!(SEMANTIC_CYCLE_REBIND_ARTIFACT_CLASSES as readonly string[]).includes(artifactClass)) {
                violations.push(`${label}.artifact_class is unsupported.`);
                return;
            }
            manifestClassCounts[artifactClass] += 1;
            const reviewScoped = REVIEW_ARTIFACT_CLASSES.has(artifactClass);
            if (reviewScoped) {
                if (
                    typeof artifactValue.review_type !== 'string'
                    || !REVIEW_TYPE_PATTERN.test(artifactValue.review_type)
                ) {
                    violations.push(`${label}.review_type must identify a canonical review lane.`);
                }
            } else if (artifactValue.review_type !== null) {
                violations.push(`${label}.review_type must be null for ${artifactClass} evidence.`);
            }
            if (
                typeof artifactValue.source_path !== 'string'
                || !artifactValue.source_path
                || path.isAbsolute(artifactValue.source_path)
                || artifactValue.source_path.split(/[\\/]/u).includes('..')
                || artifactValue.source_path.includes('\\')
            ) {
                violations.push(`${label}.source_path must be a normalized repo-relative path.`);
            }
            for (const key of ['source_sha256', 'rebound_cycle_sha256'] as const) {
                if (!SHA256_PATTERN.test(String(artifactValue[key] || ''))) {
                    violations.push(`${label}.${key} must be a lowercase SHA-256 hex string.`);
                }
            }
            if (artifactValue.accepted !== true) {
                violations.push(`${label}.accepted must be true.`);
            }
            if (!Number.isInteger(artifactValue.rebound_task_event_sequence) || Number(artifactValue.rebound_task_event_sequence) < 0) {
                violations.push(`${label}.rebound_task_event_sequence must be a non-negative integer.`);
            }
            if (isRecord(value.target_position)) {
                if (artifactValue.rebound_cycle_sha256 !== value.target_position.cycle_sha256) {
                    violations.push(`${label}.rebound_cycle_sha256 must match manifest.target_position.`);
                }
                if (artifactValue.rebound_task_event_sequence !== value.target_position.task_event_sequence) {
                    violations.push(`${label}.rebound_task_event_sequence must match manifest.target_position.`);
                }
            }
            const artifact = artifactValue as unknown as SemanticCycleReboundArtifact;
            const key = artifactKey(artifact);
            if (manifestArtifactKeys.has(key)) {
                violations.push(`${label} duplicates artifact binding '${key}'.`);
            }
            manifestArtifactKeys.add(key);
            manifestArtifacts.push(artifact);
        });
    }
    if (!isRecord(value.audit)) {
        violations.push('manifest.audit must be an object.');
    } else {
        exactKeys(value.audit, [
            'event', 'outcome', 'route', 'mutation_allowed', 'comparison_decision_sha256',
            'authoritative_snapshot_sha256', 'candidate_snapshot_sha256', 'lifecycle_authority_sha256',
            'request_sha256',
            'verified_artifact_count', 'artifact_class_counts', 'invalidation_codes', 'violations',
            'rollback_performed', 'rollback_completed'
        ], 'manifest.audit', violations);
        const committed = value.status === 'COMMITTED';
        if (value.audit.mutation_allowed !== committed) {
            violations.push('manifest.audit.mutation_allowed must match manifest.status.');
        }
        if (value.audit.outcome !== (committed ? 'REUSED' : 'INVALIDATED')) {
            violations.push('manifest.audit.outcome must match manifest.status.');
        }
        if (value.audit.event !== (
            committed ? 'SEMANTIC_CYCLE_REBIND_COMMITTED' : 'SEMANTIC_CYCLE_REBIND_INVALIDATED'
        )) {
            violations.push('manifest.audit.event must match manifest.status.');
        }
        if (!['semantic_rebind', 'existing_recovery', 'runtime_upgrade_required'].includes(String(value.audit.route || ''))) {
            violations.push('manifest.audit.route is unsupported.');
        }
        if (committed && value.audit.route !== 'semantic_rebind') {
            violations.push('A committed manifest must use semantic_rebind routing.');
        }
        if (!committed && value.audit.route === 'semantic_rebind') {
            violations.push('An invalidated manifest must preserve a fail-closed recovery route.');
        }
        for (const [auditKey, manifestKey] of [
            ['comparison_decision_sha256', 'comparison_decision_sha256'],
            ['authoritative_snapshot_sha256', 'authoritative_snapshot_sha256'],
            ['candidate_snapshot_sha256', 'candidate_snapshot_sha256'],
            ['lifecycle_authority_sha256', 'lifecycle_authority_sha256'],
            ['request_sha256', 'request_sha256']
        ] as const) {
            if (value.audit[auditKey] !== value[manifestKey]) {
                violations.push(`manifest.audit.${auditKey} must match manifest.${manifestKey}.`);
            }
        }
        if (!Number.isInteger(value.audit.verified_artifact_count) || Number(value.audit.verified_artifact_count) < 0) {
            violations.push('manifest.audit.verified_artifact_count must be a non-negative integer.');
        }
        if (!isRecord(value.audit.artifact_class_counts)) {
            violations.push('manifest.audit.artifact_class_counts must be an object.');
        } else {
            exactKeys(
                value.audit.artifact_class_counts,
                SEMANTIC_CYCLE_REBIND_ARTIFACT_CLASSES,
                'manifest.audit.artifact_class_counts',
                violations
            );
            for (const artifactClass of SEMANTIC_CYCLE_REBIND_ARTIFACT_CLASSES) {
                const count = value.audit.artifact_class_counts[artifactClass];
                if (!Number.isInteger(count) || Number(count) < 0) {
                    violations.push(`manifest.audit.artifact_class_counts.${artifactClass} must be non-negative.`);
                }
                if (committed && count !== manifestClassCounts[artifactClass]) {
                    violations.push(`manifest.audit.artifact_class_counts.${artifactClass} must match artifacts.`);
                }
            }
        }
        if (!Array.isArray(value.audit.invalidation_codes) || !value.audit.invalidation_codes.every((entry) => (
            typeof entry === 'string' && [
                'COMPARISON_BINDING_INVALID', 'COMPARISON_NOT_REUSABLE', 'LIFECYCLE_POSITION_INVALID',
                'ARTIFACT_COVERAGE_INVALID', 'ARTIFACT_HASH_MISMATCH', 'CONCURRENT_DRIFT',
                'IMMUTABLE_OUTPUT_CONFLICT', 'PERSISTENCE_FAILED', 'POST_COMMIT_VALIDATION_FAILED'
            ].includes(entry)
        ))) {
            violations.push('manifest.audit.invalidation_codes contains unsupported values.');
        }
        if (!Array.isArray(value.audit.violations) || !value.audit.violations.every((entry) => (
            typeof entry === 'string' && entry.trim().length > 0
        ))) {
            violations.push('manifest.audit.violations must contain non-empty strings.');
        }
        if (typeof value.audit.rollback_performed !== 'boolean' || typeof value.audit.rollback_completed !== 'boolean') {
            violations.push('manifest.audit rollback fields must be boolean.');
        }
        if (committed) {
            if (
                Array.isArray(value.audit.invalidation_codes)
                && Array.isArray(value.audit.violations)
                && (value.audit.invalidation_codes.length !== 0 || value.audit.violations.length !== 0)
            ) {
                violations.push('A committed manifest must not contain invalidation evidence.');
            }
            if (value.audit.verified_artifact_count !== manifestArtifacts.length) {
                violations.push('A committed manifest must verify every rebound artifact.');
            }
        } else if (Array.isArray(value.audit.invalidation_codes) && value.audit.invalidation_codes.length === 0) {
            violations.push('An invalidated manifest must contain at least one invalidation code.');
        }
    }
    if (value.status === 'COMMITTED' && Array.isArray(value.artifacts) && value.artifacts.length === 0) {
        violations.push('A committed manifest must contain rebound artifacts.');
    }
    if (value.status === 'INVALIDATED' && Array.isArray(value.artifacts) && value.artifacts.length !== 0) {
        violations.push('An invalidated manifest must not expose rebound artifacts.');
    }
    if (value.status === 'COMMITTED') {
        if (value.task_id === null) {
            violations.push('A committed manifest must identify its canonical task.');
        }
        for (const key of [
            'authoritative_snapshot_sha256', 'candidate_snapshot_sha256', 'lifecycle_authority_sha256'
        ] as const) {
            if (!SHA256_PATTERN.test(String(value[key] || ''))) {
                violations.push(`A committed manifest requires manifest.${key}.`);
            }
        }
        if (manifestClassCounts.compile !== 1 || manifestClassCounts.full_suite !== 1) {
            violations.push('A committed manifest must contain exactly one compile and one full-suite artifact.');
        }
        const reviewTypes = new Set(
            manifestArtifacts
                .filter((artifact) => REVIEW_ARTIFACT_CLASSES.has(artifact.artifact_class))
                .map((artifact) => artifact.review_type)
        );
        for (const reviewType of reviewTypes) {
            if (!reviewType) {
                continue;
            }
            for (const artifactClass of REVIEW_ARTIFACT_CLASSES) {
                if (!manifestArtifactKeys.has(`${artifactClass}:${reviewType}`)) {
                    violations.push(`Committed review lane '${reviewType}' is missing ${artifactClass} evidence.`);
                }
            }
        }
    }
    if (
        SHA256_PATTERN.test(String(value.transaction_id || ''))
        && SHA256_PATTERN.test(String(value.request_sha256 || ''))
        && value.transaction_id !== sha256Value({
            contract_id: SEMANTIC_CYCLE_REBIND_TRANSACTION_CONTRACT_ID,
            request_sha256: value.request_sha256
        })
    ) {
        violations.push('manifest.transaction_id does not bind the request.');
    }
    if (violations.length === 0) {
        const manifest = value as unknown as SemanticCycleRebindManifest;
        if (computeSemanticCycleRebindManifestSha256(manifest) !== manifest.transaction_sha256) {
            violations.push('manifest.transaction_sha256 does not authenticate the transaction payload.');
        }
    }
    return violations.length > 0
        ? { status: 'INVALID', manifest: null, violations }
        : { status: 'VALID', manifest: value as unknown as SemanticCycleRebindManifest, violations: [] };
}

function pendingMarkerPath(artifactPath: string): string {
    return `${artifactPath}.pending`;
}

interface SemanticCyclePendingMarkerValidationResult {
    marker: { schema_version: 1; transaction_sha256: string } | null;
    violations: string[];
}

function parsePendingMarker(markerPath: string): SemanticCyclePendingMarkerValidationResult {
    if (!fs.existsSync(markerPath) || !fs.statSync(markerPath).isFile()) {
        return { marker: null, violations: ['Semantic-cycle pending marker is missing.'] };
    }
    try {
        const value: unknown = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
        const violations: string[] = [];
        if (!isRecord(value)) {
            return { marker: null, violations: ['Semantic-cycle pending marker must be an object.'] };
        }
        exactKeys(value, ['schema_version', 'transaction_sha256'], 'pending marker', violations);
        if (value.schema_version !== 1) {
            violations.push('pending marker.schema_version must equal 1.');
        }
        if (!SHA256_PATTERN.test(String(value.transaction_sha256 || ''))) {
            violations.push('pending marker.transaction_sha256 must be a lowercase SHA-256 hex string.');
        }
        return violations.length > 0
            ? { marker: null, violations }
            : {
                marker: value as { schema_version: 1; transaction_sha256: string },
                violations: []
            };
    } catch (error: unknown) {
        return {
            marker: null,
            violations: [`Semantic-cycle pending marker is not valid JSON: ${
                error instanceof Error ? error.message : String(error)
            }`]
        };
    }
}

function parseManifestFile(
    artifactPath: string,
    options: { allowPending?: boolean } = {}
): SemanticCycleRebindManifestValidationResult {
    if (!options.allowPending && fs.existsSync(pendingMarkerPath(artifactPath))) {
        return {
            status: 'INVALID',
            manifest: null,
            violations: ['Semantic-cycle rebind manifest has an incomplete transaction marker.']
        };
    }
    if (!fs.existsSync(artifactPath) || !fs.statSync(artifactPath).isFile()) {
        return { status: 'INVALID', manifest: null, violations: ['Semantic-cycle rebind manifest is missing.'] };
    }
    try {
        return validateSemanticCycleRebindManifest(JSON.parse(fs.readFileSync(artifactPath, 'utf8')));
    } catch (error: unknown) {
        return {
            status: 'INVALID',
            manifest: null,
            violations: [`Semantic-cycle rebind manifest is not valid JSON: ${
                error instanceof Error ? error.message : String(error)
            }`]
        };
    }
}

function parseManifestReadSnapshot(
    artifactPath: string
): SemanticCycleRebindManifestValidationResult | null {
    if (!isReviewArtifactReadBarrierParticipant(artifactPath)) {
        return null;
    }
    const pendingSnapshot = readReviewArtifactFileSnapshot(pendingMarkerPath(artifactPath));
    if (!pendingSnapshot.active) {
        return null;
    }
    if (pendingSnapshot.exists) {
        return {
            status: 'INVALID',
            manifest: null,
            violations: ['Semantic-cycle rebind manifest has an incomplete transaction marker.']
        };
    }
    const manifestSnapshot = readReviewArtifactFileSnapshot(artifactPath);
    if (!manifestSnapshot.valid || !manifestSnapshot.content) {
        return { status: 'INVALID', manifest: null, violations: ['Semantic-cycle rebind manifest is missing.'] };
    }
    try {
        return validateSemanticCycleRebindManifest(JSON.parse(manifestSnapshot.content.toString('utf8')));
    } catch (error: unknown) {
        return {
            status: 'INVALID',
            manifest: null,
            violations: [`Semantic-cycle rebind manifest is not valid JSON: ${
                error instanceof Error ? error.message : String(error)
            }`]
        };
    }
}

export function readSemanticCycleRebindManifest(
    repoRoot: string,
    artifactPath: string
): SemanticCycleRebindManifestValidationResult {
    const resolved = resolvePathInsideRepo(artifactPath, repoRoot, { allowMissing: true, enforceInside: true });
    if (!resolved) {
        return { status: 'INVALID', manifest: null, violations: ['Semantic-cycle rebind path is missing.'] };
    }
    const snapshotResult = parseManifestReadSnapshot(resolved);
    if (snapshotResult) {
        return snapshotResult;
    }
    return withReviewArtifactLock(resolved, () => parseManifestFile(resolved)).result;
}

function persistManifest(
    artifactPath: string,
    manifest: SemanticCycleRebindManifest,
    afterWrite?: (outputPath: string) => void,
    allowPending = false
): void {
    writeFileAtomically(artifactPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8' });
    afterWrite?.(artifactPath);
    const persisted = parseManifestFile(artifactPath, { allowPending });
    if (!persisted.manifest || persisted.manifest.transaction_sha256 !== manifest.transaction_sha256) {
        throw new Error(`Persisted semantic-cycle rebind manifest failed validation: ${persisted.violations.join(' ')}`);
    }
}

function invalidationResult(
    manifest: SemanticCycleRebindManifest | null,
    audit: SemanticCycleRebindAudit,
    violations: readonly string[],
    artifactPath: string | null,
    status: 'INVALIDATED' | 'INTERRUPTED' = 'INVALIDATED'
): SemanticCycleRebindTransactionResult {
    return {
        status,
        mutation_allowed: false,
        route: audit.route,
        artifact_path: artifactPath,
        manifest,
        audit,
        violations: [...violations]
    };
}

export function executeSemanticCycleRebindTransaction(
    options: SemanticCycleRebindTransactionOptions
): SemanticCycleRebindTransactionResult {
    const comparison = compareSemanticCycleSnapshots(
        options.authoritative_snapshot,
        options.candidate_snapshot,
        options.current_runtime
    );
    const initialAssessment = assessArtifacts(options);
    const initialLifecycle = assessLifecycleAuthority(options);
    const requestSha256 = buildRequestSha256(
        options,
        initialAssessment.artifacts,
        initialLifecycle.authoritySha256
    );
    const validationCodes = new Set<SemanticCycleRebindInvalidationCode>();
    const validationViolations = [
        ...initialAssessment.violations,
        ...initialLifecycle.violations
    ];

    if (serializeSemanticCycleValue(comparison) !== serializeSemanticCycleValue(options.comparison)) {
        validationCodes.add('COMPARISON_BINDING_INVALID');
        validationViolations.push('Provided comparison result does not match the authenticated current-runtime decision.');
    }
    if (comparison.status !== 'REUSABLE' || !comparison.mutation_allowed || comparison.mismatches.length > 0) {
        validationCodes.add('COMPARISON_NOT_REUSABLE');
        validationViolations.push(
            `Semantic comparison is not reusable: status=${comparison.status}; route=${comparison.route}.`
        );
    }
    validateLifecyclePosition(options.source_position, 'source_position', validationViolations);
    validateLifecyclePosition(options.target_position, 'target_position', validationViolations);
    if (
        options.source_position.cycle_sha256 === options.target_position.cycle_sha256
        || options.target_position.task_event_sequence <= options.source_position.task_event_sequence
    ) {
        validationCodes.add('LIFECYCLE_POSITION_INVALID');
        validationViolations.push('Target lifecycle position must be a newer distinct authenticated cycle.');
    }
    if (initialAssessment.violations.length > 0) {
        validationCodes.add(initialAssessment.violations.some((entry) => entry.includes('content hash changed'))
            ? 'ARTIFACT_HASH_MISMATCH'
            : 'ARTIFACT_COVERAGE_INVALID');
    }
    if (initialLifecycle.violations.length > 0) {
        validationCodes.add('LIFECYCLE_POSITION_INVALID');
    }

    const taskId = options.authoritative_snapshot.task_id;
    if (!isCanonicalTaskId(taskId)) {
        throw new Error('Semantic-cycle rebind output ownership requires a canonical task id.');
    }
    const outputPath = joinOrchestratorPath(
        options.repo_root,
        path.join('runtime', 'reviews', `${taskId}-semantic-cycle-rebind.json`)
    );
    let suppliedOutputPath: string | null = null;
    try {
        suppliedOutputPath = resolvePathInsideRepo(options.output_path, options.repo_root, {
            allowMissing: true,
            enforceInside: true
        });
    } catch (error: unknown) {
        validationCodes.add('ARTIFACT_COVERAGE_INVALID');
        validationViolations.push(
            `Semantic-cycle rebind output path is invalid: ${error instanceof Error ? error.message : String(error)}`
        );
    }
    if (!suppliedOutputPath || !sameResolvedPath(suppliedOutputPath, outputPath)) {
        validationCodes.add('ARTIFACT_COVERAGE_INVALID');
        validationViolations.push(
            'Semantic-cycle rebind output must use the task-owned runtime review artifact path.'
        );
    }
    const sourcePaths = new Set(initialAssessment.artifacts.map((artifact) => (
        path.resolve(options.repo_root, artifact.source_path)
    )));
    if (sourcePaths.has(outputPath)) {
        validationCodes.add('ARTIFACT_COVERAGE_INVALID');
        validationViolations.push('Semantic-cycle rebind output path must not replace source evidence.');
    }

    options._testHooks?.after_initial_validation_before_lock?.();
    return withReviewArtifactLock<SemanticCycleRebindTransactionResult>(outputPath, () => {
        const transactionPendingPath = pendingMarkerPath(outputPath);
        const pending = fs.existsSync(transactionPendingPath)
            ? parsePendingMarker(transactionPendingPath)
            : null;
        let recoveringPending = false;
        let existing: SemanticCycleRebindManifestValidationResult | null = null;
        if (pending) {
            if (!pending.marker) {
                existing = {
                    status: 'INVALID',
                    manifest: null,
                    violations: pending.violations
                };
            } else if (!fs.existsSync(outputPath)) {
                try {
                    fs.rmSync(transactionPendingPath, { force: true });
                } catch {
                    // The marker remains fail-closed and is reported as an immutable conflict below.
                }
                if (fs.existsSync(transactionPendingPath)) {
                    existing = {
                        status: 'INVALID',
                        manifest: null,
                        violations: ['Interrupted marker-only transaction could not be cleared safely.']
                    };
                }
            } else {
                const pendingManifest = parseManifestFile(outputPath, { allowPending: true });
                if (
                    pendingManifest.manifest
                    && pendingManifest.manifest.transaction_sha256 === pending.marker.transaction_sha256
                ) {
                    existing = pendingManifest;
                    recoveringPending = true;
                } else {
                    existing = {
                        status: 'INVALID',
                        manifest: null,
                        violations: [
                            ...pendingManifest.violations,
                            ...(pendingManifest.manifest
                                ? ['Pending marker does not authenticate the interrupted manifest.']
                                : [])
                        ]
                    };
                }
            }
        } else if (fs.existsSync(outputPath)) {
            existing = parseManifestFile(outputPath);
        }
        let invalidationAssessment = initialAssessment;
        let invalidationLifecycle = initialLifecycle;
        if (existing?.manifest) {
            if (existing.manifest.request_sha256 === requestSha256 && validationViolations.length === 0) {
                const replayAssessment = assessArtifacts(options);
                const replayLifecycle = assessLifecycleAuthority(options);
                let commitBinding = existing.manifest.status === 'COMMITTED'
                    ? assessSemanticCycleCommitEventBinding({
                        repo_root: options.repo_root,
                        task_id: taskId,
                        manifest_path: outputPath,
                        task_events_path: options.task_events_path,
                        manifest: existing.manifest
                    })
                    : null;
                if (recoveringPending && commitBinding?.status === 'MISSING') {
                    try {
                        appendSemanticCycleCommitEvent(options, existing.manifest, outputPath);
                        commitBinding = assessSemanticCycleCommitEventBinding({
                            repo_root: options.repo_root,
                            task_id: taskId,
                            manifest_path: outputPath,
                            task_events_path: options.task_events_path,
                            manifest: existing.manifest
                        });
                    } catch (error: unknown) {
                        validationCodes.add('PERSISTENCE_FAILED');
                        replayLifecycle.violations.push(
                            `Interrupted transaction commit event could not be recorded: ${
                                error instanceof Error ? error.message : String(error)
                            }`
                        );
                    }
                }
                if (commitBinding && commitBinding.status !== 'VALID') {
                    validationCodes.add('LIFECYCLE_POSITION_INVALID');
                    replayLifecycle.violations.push(...commitBinding.violations);
                }
                const lifecycleAuthorityChanged = (
                    replayLifecycle.authoritySha256 !== initialLifecycle.authoritySha256
                );
                if (
                    replayAssessment.violations.length === 0
                    && replayLifecycle.violations.length === 0
                    && !lifecycleAuthorityChanged
                ) {
                    if (recoveringPending) {
                        try {
                            fs.rmSync(transactionPendingPath, { force: true });
                        } catch {
                            // A marker that cannot be cleared keeps the manifest fail-closed.
                        }
                        if (fs.existsSync(transactionPendingPath)) {
                            validationCodes.add('PERSISTENCE_FAILED');
                            validationViolations.push(
                                'Interrupted transaction was valid but its pending marker could not be cleared.'
                            );
                        }
                    }
                    if (!fs.existsSync(transactionPendingPath)) {
                        return existing.manifest.status === 'COMMITTED'
                            ? {
                                status: 'IDEMPOTENT' as const,
                                mutation_allowed: true,
                                route: existing.manifest.audit.route,
                                artifact_path: outputPath,
                                manifest: existing.manifest,
                                audit: existing.manifest.audit,
                                violations: []
                            }
                            : invalidationResult(
                                existing.manifest,
                                existing.manifest.audit,
                                existing.manifest.audit.violations,
                                outputPath
                            );
                    }
                }
                invalidationAssessment = replayAssessment;
                invalidationLifecycle = replayLifecycle;
                validationCodes.add('CONCURRENT_DRIFT');
                validationViolations.push(
                    'Artifact or lifecycle evidence changed before locked idempotent replay validation.',
                    ...replayAssessment.violations,
                    ...replayLifecycle.violations
                );
                if (lifecycleAuthorityChanged) {
                    validationViolations.push('Lifecycle authority bytes changed before locked replay validation.');
                }
            }
            if (existing.manifest.request_sha256 !== requestSha256) {
                validationCodes.add('IMMUTABLE_OUTPUT_CONFLICT');
                validationViolations.push('Immutable transaction output already belongs to a different request.');
            }
        } else if (existing) {
            validationCodes.add('IMMUTABLE_OUTPUT_CONFLICT');
            validationViolations.push(
                `Immutable transaction output is invalid and cannot be replaced: ${existing.violations.join(' ')}`
            );
        }

        if (validationViolations.length > 0) {
            const invalidated = buildManifest({
                options,
                requestSha256,
                artifacts: invalidationAssessment.artifacts,
                assessment: invalidationAssessment,
                status: 'INVALIDATED',
                route: comparison.status === 'RUNTIME_INCOMPATIBLE'
                    ? 'runtime_upgrade_required'
                    : 'existing_recovery',
                invalidationCodes: [...validationCodes],
                violations: validationViolations,
                lifecycleAuthoritySha256: invalidationLifecycle.authoritySha256
            });
            if (!existing) {
                persistManifest(outputPath, invalidated);
                return invalidationResult(invalidated, invalidated.audit, validationViolations, outputPath);
            }
            return invalidationResult(null, invalidated.audit, validationViolations, null);
        }

        options._testHooks?.before_final_validation?.();
        const finalAssessment = assessArtifacts(options);
        const finalLifecycle = assessLifecycleAuthority(options);
        const lifecycleAuthorityChanged = finalLifecycle.authoritySha256 !== initialLifecycle.authoritySha256;
        if (
            finalAssessment.violations.length > 0
            || finalLifecycle.violations.length > 0
            || lifecycleAuthorityChanged
        ) {
            const violations = [
                'Artifact or lifecycle evidence changed between initial validation and transaction commit.',
                ...finalAssessment.violations,
                ...finalLifecycle.violations
            ];
            if (lifecycleAuthorityChanged) {
                violations.push('Lifecycle authority bytes changed before transaction commit.');
            }
            const invalidated = buildManifest({
                options,
                requestSha256,
                artifacts: finalAssessment.artifacts,
                assessment: finalAssessment,
                status: 'INVALIDATED',
                route: 'existing_recovery',
                invalidationCodes: ['CONCURRENT_DRIFT'],
                violations,
                lifecycleAuthoritySha256: finalLifecycle.authoritySha256
            });
            persistManifest(outputPath, invalidated);
            return invalidationResult(invalidated, invalidated.audit, violations, outputPath);
        }

        const committed = buildManifest({
            options,
            requestSha256,
            artifacts: finalAssessment.artifacts,
            assessment: finalAssessment,
            status: 'COMMITTED',
            route: 'semantic_rebind',
            invalidationCodes: [],
            violations: [],
            lifecycleAuthoritySha256: finalLifecycle.authoritySha256
        });
        let persisted = false;
        let persistenceStarted = false;
        let commitEventPersisted = false;
        try {
            options._testHooks?.before_persist?.();
            writeFileAtomically(
                transactionPendingPath,
                `${JSON.stringify({
                    schema_version: 1,
                    transaction_sha256: committed.transaction_sha256
                })}\n`,
                { encoding: 'utf8' }
            );
            persistenceStarted = true;
            persistManifest(
                outputPath,
                committed,
                options._testHooks?.after_write_before_persisted_validation,
                true
            );
            persisted = true;
            options._testHooks?.after_persist_before_verification?.();
            const postCommitAssessment = assessArtifacts(options);
            const postCommitLifecycle = assessLifecycleAuthority(options);
            if (
                postCommitAssessment.violations.length > 0
                || postCommitLifecycle.violations.length > 0
                || postCommitLifecycle.authoritySha256 !== finalLifecycle.authoritySha256
            ) {
                throw new Error(
                    `Post-commit artifact or lifecycle verification detected concurrent drift: ${
                        [...postCommitAssessment.violations, ...postCommitLifecycle.violations].join(' ')
                    }`
                );
            }
            const persistedValidation = parseManifestFile(outputPath, { allowPending: true });
            if (
                !persistedValidation.manifest
                || persistedValidation.manifest.transaction_sha256 !== committed.transaction_sha256
            ) {
                throw new Error(
                    `Post-commit manifest verification failed: ${persistedValidation.violations.join(' ')}`
                );
            }
            commitEventPersisted = appendSemanticCycleCommitEvent(options, committed, outputPath);
            fs.rmSync(transactionPendingPath, { force: true });
            if (fs.existsSync(transactionPendingPath)) {
                throw new Error('Post-commit transaction marker cleanup failed.');
            }
            return {
                status: 'COMMITTED',
                mutation_allowed: true,
                route: 'semantic_rebind',
                artifact_path: outputPath,
                manifest: committed,
                audit: committed.audit,
                violations: []
            };
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            const rollbackPerformed = persistenceStarted && !commitEventPersisted && fs.existsSync(outputPath);
            let rollbackCompleted = !rollbackPerformed;
            if (rollbackPerformed) {
                try {
                    if (options._testHooks?.rollback_remove_output) {
                        options._testHooks.rollback_remove_output(outputPath);
                    } else {
                        fs.rmSync(outputPath, { force: true });
                    }
                    rollbackCompleted = !fs.existsSync(outputPath);
                } catch {
                    rollbackCompleted = false;
                }
            }
            if (!fs.existsSync(outputPath)) {
                try {
                    fs.rmSync(transactionPendingPath, { force: true });
                } catch {
                    // A pending marker without a manifest remains fail-closed and can be replaced by a later attempt.
                }
            }
            const code: SemanticCycleRebindInvalidationCode = persisted
                ? 'POST_COMMIT_VALIDATION_FAILED'
                : 'PERSISTENCE_FAILED';
            const violations = [`Semantic-cycle rebind transaction did not commit: ${message}`];
            const interrupted = buildManifest({
                options,
                requestSha256,
                artifacts: finalAssessment.artifacts,
                assessment: finalAssessment,
                status: 'INVALIDATED',
                route: 'existing_recovery',
                invalidationCodes: [code],
                violations,
                rollbackPerformed,
                rollbackCompleted,
                lifecycleAuthoritySha256: finalLifecycle.authoritySha256
            });
            return invalidationResult(null, interrupted.audit, violations, null, 'INTERRUPTED');
        }
    }).result;
}
