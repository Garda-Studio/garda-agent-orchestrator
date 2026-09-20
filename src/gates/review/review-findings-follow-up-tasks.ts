import { TASK_QUEUE_FILENAME } from '../../core/orchestration-constants';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
    getBundleCliCommand,
    getSourceCliCommand,
    resolveBundleNameForTarget
} from '../../core/constants';
import { sha256RedactedJsonPayload } from '../../core/redaction';
import { isPlainRecord } from '../../core/records';
import {
    assertCanonicalTaskId,
    isCanonicalTaskId,
    isReviewFindingsFollowUpTaskId
} from '../../core/task-ids';
import {
    buildLegacyReviewFollowUpTaskClosurePolicySnapshot,
    getReviewFollowUpTaskClosurePolicySnapshotViolations,
    type ReviewFollowUpTaskClosurePolicySnapshot
} from '../../core/review-follow-up-task-closure-policy';
import { resolveCompiledReviewDependencyGraphFromPreflight } from '../../core/review-dependency-graph';
import { allocateParentDerivedTaskIds } from '../../core/task-id-allocation';
import {
    formatActiveTaskQueueTable,
    parseCanonicalActiveTaskQueue,
    replaceTaskMdTableCell,
    type CanonicalActiveTaskQueueRow
} from '../../core/task-md-table';
import {
    withTaskQueueStatusSyncLock
} from '../../cli/commands/gate-flows/task/task-queue-sync';
import { buildOperatorNextActionBlock } from '../shared/operator-action-output';
import {
    fileSha256,
    joinOrchestratorPath,
    normalizePath
} from '../shared/helpers';
import { readReviewArtifactState } from '../next-step/next-step-review-artifact-readers';
import { reviewStateHasSatisfiedEvidence } from '../next-step/next-step-review-evidence';
import { readCurrentCompileGateEvidence } from '../review-context/review-context-validation-evidence';
import {
    REVIEW_FINDINGS_DISPOSITION_ARTIFACT_SCHEMA_VERSION,
    REVIEW_FINDINGS_DISPOSITION_ARTIFACT_TYPE,
    type ReviewFindingsDispositionArtifact,
    type ReviewFindingsDispositionArtifactItem
} from './review-findings-disposition-artifact';
import {
    validateReviewFindingsValidationArtifact,
    type NormalizedReviewFindingInventoryEntry,
    type NormalizedReviewResidualRiskInventoryEntry,
    type ReviewFindingsValidationArtifact
} from './review-findings-validation-artifact';
import type { ReviewFollowUpMaterializationMode } from '../../policy/profile-resolver';
export const REVIEW_FINDINGS_FOLLOW_UP_TASKS_ARTIFACT_TYPE = 'review_findings_follow_up_tasks';
export const REVIEW_FINDINGS_FOLLOW_UP_TASKS_ARTIFACT_SCHEMA_VERSION = 1;

const REVIEW_FINDING_SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;
const EVIDENCE_ONLY_FINDING_ID = 'F-000';
const REVIEW_TYPE_TOKEN_PATTERN = /^[a-z][a-z0-9_-]*$/u;
const REVIEW_TYPE_MAX_LENGTH = 64;
const MATERIALIZED_PARENT_NOTE_SUFFIX_PATTERN =
    /(?:\s+Review follow-up tasks materialized: `[^`\r\n]+`(?:, `[^`\r\n]+`)*; artifact `[^`\r\n]+`\.)+$/u;

type ReviewFollowUpMaterializationStatus =
    | 'MATERIALIZED'
    | 'ALREADY_MATERIALIZED'
    | 'NOT_REQUIRED'
    | 'BLOCKED';

type ReviewFindingFollowUpItemStatus =
    | 'created'
    | 'already_materialized'
    | 'not_required'
    | 'requires_fix_now'
    | 'blocked';

type SourceInventoryEntry =
    | {
        kind: 'finding';
        finding: NormalizedReviewFindingInventoryEntry;
    }
    | {
        kind: 'residual_risk';
        residual_risk: NormalizedReviewResidualRiskInventoryEntry;
    };

interface SourceInventoryIndex {
    findings: Map<string, NormalizedReviewFindingInventoryEntry>;
    residual_risks: Map<string, NormalizedReviewResidualRiskInventoryEntry>;
}

type ReviewFindingSeverity = typeof REVIEW_FINDING_SEVERITIES[number];

interface FollowUpObligation {
    disposition_item: ReviewFindingsDispositionArtifactItem;
    source_inventory: SourceInventoryEntry;
    title: string;
    description: string;
    evidence_locations: string[];
    remediation: string;
    fingerprint: string;
}

export interface FollowUpMaterializationContext {
    mode: ReviewFollowUpMaterializationMode;
    parent_profile: string | null;
    task_profile: string | null;
    task_profile_source: string;
    snapshot_hash: string | null;
    cycle_id: string | null;
    preflight_sha256: string | null;
    compile_gate_timestamp: string | null;
    group_fingerprint: string | null;
    review_follow_up_task_closure_policy: ReviewFollowUpTaskClosurePolicySnapshot;
    review_follow_up_task_closure_policy_source: 'preflight_profile_policy_snapshot' | 'legacy_default';
    diagnostics: string[];
}

interface MaterializedTaskReference {
    task_id: string;
    fingerprint: string;
}

interface TaskQueueMaterializationResult {
    outcome:
        | 'updated'
        | 'already_materialized'
        | 'not_required'
        | 'task_file_missing'
        | 'task_not_found'
        | 'write_failed';
    task_path: string;
    created: MaterializedTaskReference[];
    reused: MaterializedTaskReference[];
    blocked_fingerprints: string[];
    error_message: string | null;
    rollback_content: string | null;
}

export interface ReviewFindingsFollowUpTaskMaterializationItem {
    source_item_id: string;
    source_item_kind: ReviewFindingsDispositionArtifactItem['kind'];
    severity: ReviewFindingsDispositionArtifactItem['severity'];
    action: ReviewFindingsDispositionArtifactItem['action'];
    source_rule: string;
    source_policy: string;
    blocking: boolean;
    fingerprint: string | null;
    materialization_status: ReviewFindingFollowUpItemStatus;
    task_id: string | null;
    title: string | null;
    description: string | null;
    evidence_locations: string[];
    remediation: string | null;
}

export interface ReviewFindingsFollowUpTasksArtifact {
    schema_version: typeof REVIEW_FINDINGS_FOLLOW_UP_TASKS_ARTIFACT_SCHEMA_VERSION;
    artifact_type: typeof REVIEW_FINDINGS_FOLLOW_UP_TASKS_ARTIFACT_TYPE;
    task_id: string;
    review_type: string;
    status: ReviewFollowUpMaterializationStatus;
    created_at_utc: string;
    materialization_policy: FollowUpMaterializationContext;
    source_disposition: {
        artifact_path: string;
        artifact_sha256: string | null;
        disposition_result_sha256: string | null;
    };
    source_validation: {
        artifact_path: string | null;
        artifact_sha256: string | null;
        validation_result_sha256: string | null;
        status: 'accepted' | 'rejected' | 'unknown';
        accepted: boolean | null;
    };
    source_receipt: {
        receipt_path: string | null;
        receipt_sha256: string | null;
    };
    items: ReviewFindingsFollowUpTaskMaterializationItem[];
    summary: {
        item_count: number;
        follow_up_obligation_count: number;
        created_task_count: number;
        reused_task_count: number;
        blocked_task_count: number;
        not_required_count: number;
    };
    violations: string[];
}

export interface ReviewFindingsFollowUpTaskMaterializationResult {
    status: ReviewFollowUpMaterializationStatus;
    task_id: string;
    review_type: string;
    artifact_path: string;
    created_task_ids: string[];
    reused_task_ids: string[];
    violations: string[];
    output_lines: string[];
}

export interface MaterializeReviewFindingsFollowUpTasksOptions {
    repoRoot: string;
    taskId: string;
    reviewType: string;
    dispositionArtifactPath?: string | null;
    receiptPath?: string | null;
    artifactPath?: string | null;
    reviewsRoot?: string | null;
}

function nowIso(): string {
    return new Date().toISOString();
}

function sha256JsonPayload(value: unknown): string {
    return createHash('sha256')
        .update(`${JSON.stringify(value, null, 2)}\n`)
        .digest('hex');
}

function sha256TextPayload(value: string): string {
    return createHash('sha256').update(value, 'utf8').digest('hex').toLowerCase();
}

function normalizeHash(value: unknown): string | null {
    const normalized = String(value || '').trim().toLowerCase();
    return /^[0-9a-f]{64}$/u.test(normalized) ? normalized : null;
}

function resolveParentTaskProfile(repoRoot: string, taskId: string): string | null {
    const taskPath = path.join(repoRoot, TASK_QUEUE_FILENAME);
    if (!fs.existsSync(taskPath) || !fs.statSync(taskPath).isFile()) {
        return null;
    }
    const parsed = parseCanonicalActiveTaskQueue(fs.readFileSync(taskPath, 'utf8'));
    return parsed.rows.find((row) => row.taskId === taskId)?.profile?.trim().toLowerCase() || null;
}

function resolveFollowUpTaskProfileContext(
    parentProfile: string | null,
    snapshot: Record<string, unknown> | null
): Pick<FollowUpMaterializationContext, 'parent_profile' | 'task_profile' | 'task_profile_source' | 'diagnostics'> {
    const assignment = snapshot && isPlainRecord(snapshot.review_follow_up_task_profile_assignment)
        ? snapshot.review_follow_up_task_profile_assignment
        : null;
    const assignedParent = assignment ? normalizeText(assignment.parent_profile).toLowerCase() : '';
    const assignedProfile = assignment ? normalizeText(assignment.profile).toLowerCase() : '';
    const source = assignment ? normalizeText(assignment.source).toLowerCase() : '';
    if (
        assignedParent
        && assignedProfile
        && ['one_level_lighter', 'inherit_parent', 'fixed_profile', 'safe_inherit_parent'].includes(source)
    ) {
        return {
            parent_profile: assignedParent,
            task_profile: assignedProfile,
            task_profile_source: source,
            diagnostics: parentProfile && parentProfile !== assignedParent
                ? [
                    `Current TASK.md parent profile '${parentProfile}' differs from frozen profile '${assignedParent}'; ` +
                    `follow-up profile remains frozen as '${assignedProfile}'.`
                ]
                : []
        };
    }
    return {
        parent_profile: parentProfile,
        task_profile: parentProfile,
        task_profile_source: 'legacy_safe_inherit_parent',
        diagnostics: [
            'Legacy or missing follow-up task profile assignment inherited the parent TASK.md profile.'
        ]
    };
}

function resolveFollowUpMaterializationContext(
    repoRoot: string,
    reviewsRoot: string,
    taskId: string
): FollowUpMaterializationContext {
    const preflightPath = path.join(reviewsRoot, `${taskId}-preflight.json`);
    const parentProfile = resolveParentTaskProfile(repoRoot, taskId);
    const initialTaskProfileContext = resolveFollowUpTaskProfileContext(parentProfile, null);
    const legacyClosurePolicy = buildLegacyReviewFollowUpTaskClosurePolicySnapshot();
    const fallback: FollowUpMaterializationContext = {
        mode: 'per_finding',
        ...initialTaskProfileContext,
        snapshot_hash: null,
        cycle_id: null,
        preflight_sha256: null,
        compile_gate_timestamp: null,
        group_fingerprint: null,
        review_follow_up_task_closure_policy: legacyClosurePolicy,
        review_follow_up_task_closure_policy_source: 'legacy_default',
        diagnostics: [
            ...initialTaskProfileContext.diagnostics,
            'Legacy or missing profile snapshot review_follow_up_policy defaulted to per_finding.'
        ]
    };
    const read = readJsonFile(preflightPath, 'Preflight artifact');
    const snapshot = read.value && isPlainRecord(read.value.profile_policy_snapshot)
        ? read.value.profile_policy_snapshot
        : null;
    const taskProfileContext = resolveFollowUpTaskProfileContext(parentProfile, snapshot);
    const closurePolicyValue = snapshot?.review_follow_up_task_closure_policy;
    const closurePolicyViolations = getReviewFollowUpTaskClosurePolicySnapshotViolations(closurePolicyValue);
    const closurePolicy = closurePolicyViolations.length === 0
        ? {
            ...(closurePolicyValue as unknown as ReviewFollowUpTaskClosurePolicySnapshot),
            diagnostics: [
                ...(closurePolicyValue as unknown as ReviewFollowUpTaskClosurePolicySnapshot).diagnostics
            ]
        }
        : legacyClosurePolicy;
    const closurePolicySource = closurePolicyViolations.length === 0
        ? 'preflight_profile_policy_snapshot' as const
        : 'legacy_default' as const;
    const closurePolicyDiagnostics = closurePolicyViolations.length === 0
        ? []
        : [
            'Preflight closure-policy snapshot is missing or invalid; descendant materialization uses legacy fail-closed defaults.'
        ];
    const policy = snapshot && isPlainRecord(snapshot.review_follow_up_policy)
        ? snapshot.review_follow_up_policy
        : null;
    const mode = policy?.schema_version === 1
        && (policy.materialization_mode === 'per_finding' || policy.materialization_mode === 'grouped_by_parent')
        ? policy.materialization_mode
        : null;
    if (!mode) {
        return {
            ...fallback,
            review_follow_up_task_closure_policy: closurePolicy,
            review_follow_up_task_closure_policy_source: closurePolicySource,
            diagnostics: [
                ...taskProfileContext.diagnostics,
                ...closurePolicyDiagnostics,
                'Legacy or missing profile snapshot review_follow_up_policy defaulted to per_finding.'
            ]
        };
    }
    const snapshotHash = normalizeHash(snapshot?.snapshot_hash);
    const compileGatePath = path.join(reviewsRoot, `${taskId}-compile-gate.json`);
    const compileRead = readJsonFile(compileGatePath, 'Compile gate artifact');
    const compileGate = compileRead.value && isPlainRecord(compileRead.value)
        ? compileRead.value
        : null;
    const compileGateEvidence = readCurrentCompileGateEvidence(repoRoot, taskId);
    const canonicalCompileTimestamp = compileGateEvidence.timeline_timestamp_utc
        || compileGateEvidence.artifact_timestamp_utc;
    const compileTimestamp = compileGate?.status === 'PASSED'
        && normalizeText(compileGate.task_id) === taskId
        ? normalizeText(canonicalCompileTimestamp)
        : '';
    const compilePreflightSha256 = normalizeHash(compileGate?.preflight_hash_sha256);
    const currentPreflightSha256 = fs.existsSync(preflightPath) ? fileSha256(preflightPath) : null;
    const cycleId = compileTimestamp
        && compilePreflightSha256
        && compilePreflightSha256 === currentPreflightSha256
        ? sha256JsonPayload({
            schema_version: 1,
            preflight_sha256: compilePreflightSha256,
            compile_gate_timestamp: compileTimestamp
        })
        : null;
    if (mode === 'grouped_by_parent' && (!snapshotHash || !cycleId)) {
        return {
            mode,
            ...taskProfileContext,
            snapshot_hash: snapshotHash,
            cycle_id: null,
            preflight_sha256: compilePreflightSha256,
            compile_gate_timestamp: compileTimestamp || null,
            group_fingerprint: null,
            review_follow_up_task_closure_policy: closurePolicy,
            review_follow_up_task_closure_policy_source: closurePolicySource,
            diagnostics: [
                ...taskProfileContext.diagnostics,
                ...closurePolicyDiagnostics,
                'Grouped follow-up policy requires snapshot_hash and a current preflight-bound compile cycle; materialization is blocked.'
            ]
        };
    }
    return {
        mode,
        ...taskProfileContext,
        snapshot_hash: snapshotHash,
        cycle_id: cycleId,
        preflight_sha256: compilePreflightSha256,
        compile_gate_timestamp: compileTimestamp || null,
        group_fingerprint: mode === 'grouped_by_parent'
            ? sha256JsonPayload({
                schema_version: 1,
                parent_task_id: taskId,
                snapshot_hash: snapshotHash,
                cycle_id: cycleId,
                materialization_mode: mode
            })
            : null,
        review_follow_up_task_closure_policy: closurePolicy,
        review_follow_up_task_closure_policy_source: closurePolicySource,
        diagnostics: [
            ...taskProfileContext.diagnostics,
            ...closurePolicyDiagnostics
        ]
    };
}

function normalizeText(value: unknown): string {
    return String(value || '').trim();
}

function assertReviewTypeToken(value: unknown): string {
    const reviewType = normalizeText(value).toLowerCase();
    if (!reviewType) {
        throw new Error('ReviewType must not be empty.');
    }
    if (reviewType.length > REVIEW_TYPE_MAX_LENGTH) {
        throw new Error(`ReviewType must be ${REVIEW_TYPE_MAX_LENGTH} characters or fewer.`);
    }
    if (!REVIEW_TYPE_TOKEN_PATTERN.test(reviewType)) {
        throw new Error('ReviewType must be a file-safe token matching <letter>[a-z0-9_-]*.');
    }
    return reviewType;
}

function isReviewTypeToken(value: unknown): boolean {
    try {
        assertReviewTypeToken(value);
        return true;
    } catch {
        return false;
    }
}

function writeJson(filePath: string, value: unknown): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function tryWriteJson(filePath: string, value: unknown, label: string): string | null {
    try {
        writeJson(filePath, value);
        return null;
    } catch (error: unknown) {
        return `${label} write failed: ${errorMessage(error)}.`;
    }
}

function readJsonFile(filePath: string, label: string): { value: Record<string, unknown> | null; violations: string[] } {
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        return {
            value: null,
            violations: [`${label} is missing: ${normalizePath(filePath)}.`]
        };
    }
    try {
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
        if (!isPlainRecord(parsed)) {
            return {
                value: null,
                violations: [`${label} must contain a JSON object: ${normalizePath(filePath)}.`]
            };
        }
        return { value: parsed, violations: [] };
    } catch {
        return {
            value: null,
            violations: [`${label} is not valid JSON: ${normalizePath(filePath)}.`]
        };
    }
}

function resolveInputPathInsideRepo(repoRoot: string, inputPath: string, label: string): string {
    const rawPath = String(inputPath || '').trim();
    if (!rawPath) {
        throw new Error(`${label} must not be empty.`);
    }
    const resolved = path.isAbsolute(rawPath)
        ? path.resolve(rawPath)
        : path.resolve(repoRoot, rawPath);
    const root = path.resolve(repoRoot);
    if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
        throw new Error(`${label} escapes repo root: ${inputPath}`);
    }
    return resolved;
}

function resolveFollowUpArtifactPath(repoRoot: string, reviewsRoot: string, inputPath: string): string {
    const resolved = resolveInputPathInsideRepo(repoRoot, inputPath, 'ArtifactPath');
    const root = path.resolve(reviewsRoot);
    if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
        throw new Error(`ArtifactPath must stay inside reviews root: ${inputPath}`);
    }
    if (!path.basename(resolved).endsWith('-follow-ups.json')) {
        throw new Error('ArtifactPath must be a follow-up JSON artifact path ending in -follow-ups.json.');
    }
    return resolved;
}

function buildCliPrefix(repoRoot: string): string {
    return fs.existsSync(path.join(path.resolve(repoRoot), 'bin', 'garda.js'))
        ? getSourceCliCommand()
        : getBundleCliCommand(resolveBundleNameForTarget(repoRoot));
}

function buildNextStepCommand(repoRoot: string, taskId: string): string {
    return `${buildCliPrefix(repoRoot)} next-step "${taskId}" --repo-root "."`;
}

function formatOutput(params: {
    repoRoot: string;
    taskId: string;
    status: ReviewFollowUpMaterializationStatus;
    marker: string;
    action: string;
    reason?: string | null;
    artifactPath: string;
    violations: readonly string[];
}): string[] {
    const blocked = params.status === 'BLOCKED';
    return [
        ...buildOperatorNextActionBlock({
            status: params.status,
            gate: 'review-findings-follow-up-tasks',
            action: params.action,
            reason: params.reason,
            command: blocked ? null : buildNextStepCommand(params.repoRoot, params.taskId),
            commandReference: blocked ? 'resolve blockers listed in details before retrying materialization' : null,
            detailsPath: params.artifactPath,
            detailsHint: blocked ? `${params.violations.length} blocker(s) recorded in the materialization artifact.` : null
        }),
        '',
        params.marker,
        `ArtifactPath: ${normalizePath(params.artifactPath)}`,
        ...(params.violations.length > 0
            ? ['Violations:', ...params.violations.map((violation) => `- ${violation}`)]
            : [])
    ];
}

function getFallbackArtifactPath(repoRoot: string, taskId: string, reviewType: string): string {
    const safeTaskId = isCanonicalTaskId(taskId) ? normalizeText(taskId) : 'UNKNOWN-TASK';
    const safeReviewType = isReviewTypeToken(reviewType) ? assertReviewTypeToken(reviewType) : 'unknown-review';
    return joinOrchestratorPath(
        repoRoot,
        path.join('runtime', 'reviews', `${safeTaskId}-${safeReviewType}-findings-follow-ups.json`)
    );
}

export function getReviewFindingsFollowUpTasksArtifactPath(dispositionArtifactPath: string): string {
    const normalized = String(dispositionArtifactPath || '').trim();
    if (/-findings-disposition\.json$/u.test(normalized)) {
        return normalized.replace(/-findings-disposition\.json$/u, '-findings-follow-ups.json');
    }
    return normalized.replace(/\.json$/u, '-follow-ups.json');
}

function parseDispositionArtifact(value: Record<string, unknown>): ReviewFindingsDispositionArtifact | null {
    if (
        value.schema_version !== REVIEW_FINDINGS_DISPOSITION_ARTIFACT_SCHEMA_VERSION
        || value.artifact_type !== REVIEW_FINDINGS_DISPOSITION_ARTIFACT_TYPE
        || !isPlainRecord(value.source_validation)
        || !Array.isArray(value.items)
        || !value.items.every((item) => isPlainRecord(item))
        || !isPlainRecord(value.policy)
        || !isPlainRecord(value.disposition_result)
        || typeof value.disposition_result_sha256 !== 'string'
    ) {
        return null;
    }
    return value as unknown as ReviewFindingsDispositionArtifact;
}

function isReviewFindingSeverity(value: unknown): value is ReviewFindingSeverity {
    return typeof value === 'string' && (REVIEW_FINDING_SEVERITIES as readonly string[]).includes(value);
}

function expectedSourceRuleForItem(
    artifact: ReviewFindingsDispositionArtifact,
    item: ReviewFindingsDispositionArtifactItem
): string | null {
    const policy = artifact.policy as unknown as Record<string, unknown>;
    const closurePolicy = isPlainRecord(policy.review_follow_up_task_closure_policy)
        ? policy.review_follow_up_task_closure_policy
        : null;
    const basePolicy = isPlainRecord(policy.base_review_finding_policy)
        ? policy.base_review_finding_policy
        : null;
    const baseFindings = basePolicy && isPlainRecord(basePolicy.findings)
        ? basePolicy.findings
        : null;
    const effectivePolicy = isPlainRecord(policy.review_finding_policy)
        ? policy.review_finding_policy
        : null;
    const effectiveFindings = effectivePolicy && isPlainRecord(effectivePolicy.findings)
        ? effectivePolicy.findings
        : null;
    if (
        isReviewFindingsFollowUpTaskId(artifact.task_id)
        && item.kind === 'finding'
        && item.severity === 'low'
        && closurePolicy?.skip_low_findings === true
        && baseFindings?.low !== effectiveFindings?.low
        && item.action === 'ignore'
    ) {
        return 'review_follow_up_task_closure_policy.skip_low_findings';
    }
    const baseAction = item.kind === 'residual_risk'
        ? basePolicy?.residual_risk
        : (isReviewFindingSeverity(item.severity) ? baseFindings?.[item.severity] : null);
    if (
        isReviewFindingsFollowUpTaskId(artifact.task_id)
        && closurePolicy?.forbid_child_tasks === true
        && baseAction === 'create_follow_up'
        && item.action === 'fix_now'
    ) {
        return 'review_follow_up_task_closure_policy.forbid_child_tasks';
    }
    if (item.kind === 'residual_risk') {
        return 'review_finding_policy.residual_risk';
    }
    if (isReviewFindingSeverity(item.severity)) {
        return `review_finding_policy.findings.${item.severity}`;
    }
    return null;
}

function expectedClosurePolicyActionForItem(
    artifact: ReviewFindingsDispositionArtifact,
    item: ReviewFindingsDispositionArtifactItem
): string | null {
    if (
        !isReviewFindingsFollowUpTaskId(artifact.task_id)
        || item.kind !== 'finding'
        || item.severity !== 'low'
    ) {
        return null;
    }
    const policy = artifact.policy as unknown as Record<string, unknown>;
    const closurePolicy = isPlainRecord(policy.review_follow_up_task_closure_policy)
        ? policy.review_follow_up_task_closure_policy
        : null;
    return closurePolicy?.eligible === true
        && closurePolicy.valid === true
        && closurePolicy.skip_low_findings === true
        ? 'ignore'
        : null;
}

function expectedMaterializationStatusForAction(action: unknown): string | null {
    if (action === 'fix_now') {
        return 'requires_fix_now';
    }
    if (action === 'create_follow_up') {
        return 'pending_follow_up_materialization';
    }
    if (action === 'ignore') {
        return 'audited_ignored';
    }
    return null;
}

function dispositionItemKey(kind: ReviewFindingsDispositionArtifactItem['kind'], severity: string, id: string): string {
    return `${kind}:${severity}:${id}`;
}

function dispositionResultItemKeys(artifact: ReviewFindingsDispositionArtifact): Array<{
    key: string;
    path: string;
    id: string;
    action: string | null;
}> {
    const result = artifact.disposition_result as unknown as Record<string, unknown>;
    const keys: Array<{ key: string; path: string; id: string; action: string | null }> = [];
    const findings = isPlainRecord(result.findings) ? result.findings : {};
    for (const severity of REVIEW_FINDING_SEVERITIES) {
        const bucket = findings[severity];
        if (!isPlainRecord(bucket) || !Array.isArray(bucket.ids)) {
            continue;
        }
        const action = typeof bucket.action === 'string' ? bucket.action : null;
        for (const rawId of bucket.ids) {
            const id = normalizeText(rawId);
            if (!id) {
                continue;
            }
            keys.push({
                key: dispositionItemKey('finding', severity, id),
                path: `disposition_result.findings.${severity}`,
                id,
                action
            });
        }
    }

    const residualRiskBucket = result.residual_risks;
    if (isPlainRecord(residualRiskBucket) && Array.isArray(residualRiskBucket.ids)) {
        const action = typeof residualRiskBucket.action === 'string' ? residualRiskBucket.action : null;
        for (const rawId of residualRiskBucket.ids) {
            const id = normalizeText(rawId);
            if (!id) {
                continue;
            }
            keys.push({
                key: dispositionItemKey('residual_risk', 'residual_risk', id),
                path: 'disposition_result.residual_risks',
                id,
                action
            });
        }
    }

    return keys;
}

function validateDispositionArtifactShape(params: {
    artifact: ReviewFindingsDispositionArtifact;
    artifactPath: string;
    taskId: string;
    reviewType: string;
}): string[] {
    const { artifact, artifactPath, taskId, reviewType } = params;
    const violations: string[] = [];
    if (artifact.task_id !== taskId) {
        violations.push(
            `Review findings disposition artifact task_id mismatch: expected ${taskId}, found ${artifact.task_id || 'missing'}.`
        );
    }
    if (artifact.review_type !== reviewType) {
        violations.push(
            `Review findings disposition artifact review_type mismatch: expected ${reviewType}, found ${artifact.review_type || 'missing'}.`
        );
    }
    if (artifact.derivation_source !== 'garda_locked_policy_evaluation') {
        violations.push('Review findings disposition artifact derivation_source must be garda_locked_policy_evaluation.');
    }
    const sourceValidation = artifact.source_validation;
    if (sourceValidation.status !== 'accepted' || sourceValidation.accepted !== true) {
        violations.push('Review findings disposition artifact must be bound to an accepted system validation artifact.');
    }
    if (!sourceValidation.artifact_path) {
        violations.push('Review findings disposition artifact source_validation.artifact_path is missing.');
    }
    if (!normalizeHash(sourceValidation.artifact_sha256)) {
        violations.push('Review findings disposition artifact source_validation.artifact_sha256 is missing or invalid.');
    }
    if (!normalizeHash(sourceValidation.validation_result_sha256)) {
        violations.push('Review findings disposition artifact source_validation.validation_result_sha256 is missing or invalid.');
    }
    const actualDispositionResultSha256 = sha256RedactedJsonPayload(artifact.disposition_result);
    if (artifact.disposition_result_sha256 !== actualDispositionResultSha256) {
        violations.push(
            `Review findings disposition artifact '${normalizePath(artifactPath)}' disposition_result_sha256 mismatch: ` +
            `expected ${actualDispositionResultSha256}, found ${artifact.disposition_result_sha256 || 'missing'}.`
        );
    }
    const artifactPolicySource = normalizeText(artifact.policy.policy_source);
    if (!artifactPolicySource) {
        violations.push('Review findings disposition artifact policy.policy_source is missing.');
    }
    const artifactPolicy = artifact.policy as unknown as Record<string, unknown>;
    const dispositionResult = artifact.disposition_result as unknown as Record<string, unknown>;
    const policyClosureValue = artifactPolicy.review_follow_up_task_closure_policy;
    const resultClosureValue = dispositionResult.review_follow_up_task_closure_policy;
    if (policyClosureValue !== undefined || resultClosureValue !== undefined) {
        const policyClosureViolations = getReviewFollowUpTaskClosurePolicySnapshotViolations(policyClosureValue);
        const resultClosureViolations = getReviewFollowUpTaskClosurePolicySnapshotViolations(resultClosureValue);
        violations.push(...policyClosureViolations.map((violation) => (
            `Review findings disposition artifact policy ${violation}`
        )));
        violations.push(...resultClosureViolations.map((violation) => (
            `Review findings disposition result ${violation}`
        )));
        if (
            policyClosureViolations.length === 0
            && resultClosureViolations.length === 0
            && sha256JsonPayload(policyClosureValue) !== sha256JsonPayload(resultClosureValue)
        ) {
            violations.push(
                'Review findings disposition policy and disposition_result closure-policy snapshots must match.'
            );
        }
    }
    const dispositionResultItems = dispositionResultItemKeys(artifact);
    const dispositionResultActionsByItemKey = new Map<string, string>();
    for (const resultItem of dispositionResultItems) {
        if (resultItem.action) {
            dispositionResultActionsByItemKey.set(resultItem.key, resultItem.action);
        }
    }
    const dispositionItemKeys = new Set<string>();
    for (const item of artifact.items) {
        const itemId = normalizeText(item.id);
        if (!itemId) {
            violations.push('Review findings disposition item is missing id.');
        }
        if (item.kind !== 'finding' && item.kind !== 'residual_risk') {
            violations.push(`Review findings disposition item '${item.id || 'missing'}' has invalid kind.`);
        }
        if (item.kind === 'finding' && !isReviewFindingSeverity(item.severity)) {
            violations.push(`Review findings disposition item '${item.id || 'missing'}' has invalid finding severity.`);
        }
        if (item.kind === 'residual_risk' && item.severity !== 'residual_risk') {
            violations.push(`Review findings disposition item '${item.id || 'missing'}' residual risk severity must be residual_risk.`);
        }
        if (item.action !== 'fix_now' && item.action !== 'create_follow_up' && item.action !== 'ignore') {
            violations.push(`Review findings disposition item '${item.id || 'missing'}' has invalid action.`);
        }
        const key = item.kind === 'residual_risk'
            ? dispositionItemKey('residual_risk', 'residual_risk', itemId)
            : isReviewFindingSeverity(item.severity)
                ? dispositionItemKey('finding', item.severity, itemId)
                : null;
        const dispositionResultAction = key
            ? dispositionResultActionsByItemKey.get(key) || null
            : null;
        if (!dispositionResultAction) {
            violations.push(
                `Review findings disposition item '${item.id || 'missing'}' is not present in disposition_result.`
            );
        } else if (item.action !== dispositionResultAction) {
            violations.push(
                `Review findings disposition item '${item.id || 'missing'}' action '${item.action}' does not match ` +
                `disposition_result action '${dispositionResultAction}'.`
            );
        }
        const expectedClosurePolicyAction = expectedClosurePolicyActionForItem(artifact, item);
        if (expectedClosurePolicyAction && item.action !== expectedClosurePolicyAction) {
            violations.push(
                `Review findings disposition item '${item.id || 'missing'}' must use action ` +
                `'${expectedClosurePolicyAction}' under frozen skip_low_findings closure policy.`
            );
        }
        const expectedSourceRule = expectedSourceRuleForItem(artifact, item);
        if (!expectedSourceRule || normalizeText(item.source_rule) !== expectedSourceRule) {
            violations.push(
                `Review findings disposition item '${item.id || 'missing'}' source_rule must be ` +
                `${expectedSourceRule || 'valid for its kind and severity'}.`
            );
        }
        if (normalizeText(item.policy_source) !== artifactPolicySource) {
            violations.push(
                `Review findings disposition item '${item.id || 'missing'}' policy_source must match the disposition artifact policy_source.`
            );
        }
        const expectedBlocking = item.action === 'fix_now';
        if (typeof item.blocking !== 'boolean') {
            violations.push(`Review findings disposition item '${item.id || 'missing'}' blocking flag must be boolean.`);
        } else if (item.blocking !== expectedBlocking) {
            violations.push(
                `Review findings disposition item '${item.id || 'missing'}' blocking flag does not match action '${item.action}'.`
            );
        }
        if (key) {
            if (dispositionItemKeys.has(key)) {
                violations.push(`Review findings disposition item '${item.id || 'missing'}' is duplicated.`);
            }
            dispositionItemKeys.add(key);
        }
        const expectedMaterializationStatus = expectedMaterializationStatusForAction(item.action);
        if (expectedMaterializationStatus && item.materialization_status !== expectedMaterializationStatus) {
            violations.push(
                `Review findings disposition item '${item.id || 'missing'}' materialization_status must be ` +
                `${expectedMaterializationStatus} for action '${item.action}'.`
            );
        }
        if (item.audit_status !== 'retained_in_disposition_artifact') {
            violations.push(
                `Review findings disposition item '${item.id || 'missing'}' audit_status must be retained_in_disposition_artifact.`
            );
        }
    }
    for (const resultItem of dispositionResultItems) {
        if (!dispositionItemKeys.has(resultItem.key)) {
            violations.push(
                `Review findings ${resultItem.path} id '${resultItem.id}' is missing a matching disposition item.`
            );
        }
    }
    return violations;
}

function validateValidationInventoryShape(artifact: ReviewFindingsValidationArtifact): string[] {
    const violations: string[] = [];
    const inventory = artifact.validation_result.normalized_inventory as unknown;
    if (!isPlainRecord(inventory)) {
        return ['Review findings validation artifact normalized_inventory must be an object.'];
    }
    if (!isPlainRecord(inventory.findings_by_severity)) {
        violations.push('Review findings validation artifact normalized_inventory.findings_by_severity must be an object.');
    } else {
        const seenFindingIds = new Set<string>();
        for (const severity of REVIEW_FINDING_SEVERITIES) {
            const bucket = inventory.findings_by_severity[severity];
            if (!Array.isArray(bucket)) {
                violations.push(
                    `Review findings validation artifact normalized_inventory.findings_by_severity.${severity} must be an array.`
                );
                continue;
            }
            bucket.forEach((entry, index) => {
                if (!isPlainRecord(entry)) {
                    violations.push(
                        `Review findings validation artifact ${severity} finding inventory entry ${index} must be an object.`
                    );
                    return;
                }
                const id = normalizeText(entry.id);
                if (!id) {
                    violations.push(
                        `Review findings validation artifact ${severity} finding inventory entry ${index} is missing id.`
                    );
                } else {
                    if (seenFindingIds.has(id)) {
                        violations.push(
                            `Review findings validation artifact duplicate finding inventory id '${id}' for severity '${severity}'.`
                        );
                    }
                    seenFindingIds.add(id);
                }
                if (entry.severity !== severity) {
                    violations.push(
                        `Review findings validation artifact ${severity} finding inventory entry ${index} has mismatched severity.`
                    );
                }
                if (!normalizeText(entry.title)) {
                    violations.push(
                        `Review findings validation artifact ${severity} finding inventory entry ${index} is missing title.`
                    );
                }
                if (!normalizeText(entry.description)) {
                    violations.push(
                        `Review findings validation artifact ${severity} finding inventory entry ${index} is missing description.`
                    );
                }
                if (!Array.isArray(entry.evidence_locations)) {
                    violations.push(
                        `Review findings validation artifact ${severity} finding inventory entry ${index} evidence_locations must be an array.`
                    );
                }
                if (!Array.isArray(entry.coverage_obligation_ids)) {
                    violations.push(
                        `Review findings validation artifact ${severity} finding inventory entry ${index} coverage_obligation_ids must be an array.`
                    );
                }
            });
        }
    }
    if (!Array.isArray(inventory.residual_risks)) {
        violations.push('Review findings validation artifact normalized_inventory.residual_risks must be an array.');
    } else {
        const seenResidualRiskIds = new Set<string>();
        inventory.residual_risks.forEach((entry, index) => {
            if (!isPlainRecord(entry)) {
                violations.push(
                    `Review findings validation artifact residual risk inventory entry ${index} must be an object.`
                );
                return;
            }
            const id = normalizeText(entry.id);
            if (!id) {
                violations.push(`Review findings validation artifact residual risk inventory entry ${index} is missing id.`);
            } else {
                if (seenResidualRiskIds.has(id)) {
                    violations.push(
                        `Review findings validation artifact duplicate residual risk inventory id '${id}'.`
                    );
                }
                seenResidualRiskIds.add(id);
            }
            if (!normalizeText(entry.description)) {
                violations.push(
                    `Review findings validation artifact residual risk inventory entry ${index} is missing description.`
                );
            }
            if (!Array.isArray(entry.evidence_locations)) {
                violations.push(
                    `Review findings validation artifact residual risk inventory entry ${index} evidence_locations must be an array.`
                );
            }
        });
    }
    return violations;
}

function validateDispositionInventoryCompleteness(params: {
    disposition: ReviewFindingsDispositionArtifact;
    validation: ReviewFindingsValidationArtifact;
}): string[] {
    const violations: string[] = [];
    const resultKeys = new Set(
        dispositionResultItemKeys(params.disposition).map((item) => item.key)
    );
    const dispositionItemKeys = new Set(
        params.disposition.items.map((item) => dispositionItemKey(item.kind, item.severity, item.id))
    );
    const inventory = params.validation.validation_result.normalized_inventory;

    for (const severity of REVIEW_FINDING_SEVERITIES) {
        for (const finding of inventory.findings_by_severity[severity]) {
            if (finding.id === EVIDENCE_ONLY_FINDING_ID) {
                continue;
            }
            const key = dispositionItemKey('finding', severity, finding.id);
            if (!resultKeys.has(key)) {
                violations.push(
                    `Accepted validation inventory finding '${finding.id}' at severity '${severity}' is missing from disposition_result.`
                );
            }
            if (!dispositionItemKeys.has(key)) {
                violations.push(
                    `Accepted validation inventory finding '${finding.id}' at severity '${severity}' is missing a disposition item.`
                );
            }
        }
    }

    for (const residualRisk of inventory.residual_risks) {
        const key = dispositionItemKey('residual_risk', 'residual_risk', residualRisk.id);
        if (!resultKeys.has(key)) {
            violations.push(
                `Accepted validation inventory residual risk '${residualRisk.id}' is missing from disposition_result.`
            );
        }
        if (!dispositionItemKeys.has(key)) {
            violations.push(
                `Accepted validation inventory residual risk '${residualRisk.id}' is missing a disposition item.`
            );
        }
    }

    return violations;
}

function sourceFindingIndexKey(id: string, severity: string): string {
    return `${severity}\0${id}`;
}

function buildSourceInventoryIndex(artifact: ReviewFindingsValidationArtifact): SourceInventoryIndex {
    const findings = new Map<string, NormalizedReviewFindingInventoryEntry>();
    const findingsBySeverity = artifact.validation_result.normalized_inventory.findings_by_severity;
    for (const severity of REVIEW_FINDING_SEVERITIES) {
        for (const finding of findingsBySeverity[severity]) {
            findings.set(sourceFindingIndexKey(finding.id, finding.severity), finding);
        }
    }

    const residualRisks = new Map<string, NormalizedReviewResidualRiskInventoryEntry>();
    for (const residualRisk of artifact.validation_result.normalized_inventory.residual_risks) {
        residualRisks.set(residualRisk.id, residualRisk);
    }

    return {
        findings,
        residual_risks: residualRisks
    };
}

function findSourceInventoryEntry(
    index: SourceInventoryIndex,
    item: ReviewFindingsDispositionArtifactItem
): SourceInventoryEntry | null {
    if (item.kind === 'finding') {
        const finding = index.findings.get(sourceFindingIndexKey(item.id, item.severity));
        return finding ? { kind: 'finding', finding } : null;
    }
    const residualRisk = index.residual_risks.get(item.id);
    return residualRisk ? { kind: 'residual_risk', residual_risk: residualRisk } : null;
}

function sourceTitle(entry: SourceInventoryEntry): string {
    if (entry.kind === 'finding') {
        return entry.finding.title;
    }
    return entry.residual_risk.description.split(/[.?!]\s/u)[0] || entry.residual_risk.description;
}

function sourceDescription(entry: SourceInventoryEntry): string {
    return entry.kind === 'finding'
        ? entry.finding.description
        : entry.residual_risk.description;
}

function sourceEvidenceLocations(entry: SourceInventoryEntry): string[] {
    return entry.kind === 'finding'
        ? [...entry.finding.evidence_locations]
        : [...entry.residual_risk.evidence_locations];
}

function buildRemediationText(item: ReviewFindingsDispositionArtifactItem): string {
    const severity = item.severity === 'residual_risk'
        ? 'residual risk'
        : `${item.severity} finding`;
    return `Address accepted ${severity} ${item.id} according to ${item.source_rule}; keep validation and receipt hashes in the follow-up notes.`;
}

function buildFingerprint(params: {
    taskId: string;
    reviewType: string;
    item: ReviewFindingsDispositionArtifactItem;
    validationArtifactSha256: string;
    validationResultSha256: string;
    dispositionArtifactSha256: string;
    dispositionResultSha256: string;
}): string {
    return sha256JsonPayload({
        schema_version: 1,
        parent_task_id: params.taskId,
        review_type: params.reviewType,
        item_id: params.item.id,
        item_kind: params.item.kind,
        severity: params.item.severity,
        action: params.item.action,
        source_rule: params.item.source_rule,
        validation_artifact_sha256: params.validationArtifactSha256,
        validation_result_sha256: params.validationResultSha256,
        disposition_artifact_sha256: params.dispositionArtifactSha256,
        disposition_result_sha256: params.dispositionResultSha256
    });
}

function buildObligations(params: {
    taskId: string;
    reviewType: string;
    disposition: ReviewFindingsDispositionArtifact;
    validation: ReviewFindingsValidationArtifact;
    dispositionArtifactSha256: string;
}): { obligations: FollowUpObligation[]; items: ReviewFindingsFollowUpTaskMaterializationItem[]; violations: string[] } {
    const obligations: FollowUpObligation[] = [];
    const items: ReviewFindingsFollowUpTaskMaterializationItem[] = [];
    const violations: string[] = [];
    const validationArtifactSha256 = params.disposition.source_validation.artifact_sha256;
    const validationResultSha256 = params.disposition.source_validation.validation_result_sha256;
    const sourceInventoryIndex = buildSourceInventoryIndex(params.validation);

    for (const item of params.disposition.items) {
        const sourceInventory = findSourceInventoryEntry(sourceInventoryIndex, item);
        if (!sourceInventory) {
            violations.push(
                `Review findings disposition item '${item.id}' is not present in the accepted validation inventory.`
            );
            items.push(buildArtifactItem({
                item,
                status: blockedStatusForDispositionItem(item),
                taskId: null,
                fingerprint: null,
                title: null,
                description: null,
                evidenceLocations: [],
                remediation: null
            }));
            continue;
        }

        const title = sourceTitle(sourceInventory);
        const description = sourceDescription(sourceInventory);
        const evidenceLocations = sourceEvidenceLocations(sourceInventory);
        const remediation = buildRemediationText(item);
        const fingerprint = buildFingerprint({
            taskId: params.taskId,
            reviewType: params.reviewType,
            item,
            validationArtifactSha256,
            validationResultSha256,
            dispositionArtifactSha256: params.dispositionArtifactSha256,
            dispositionResultSha256: params.disposition.disposition_result_sha256
        });

        if (item.action === 'create_follow_up') {
            obligations.push({
                disposition_item: item,
                source_inventory: sourceInventory,
                title,
                description,
                evidence_locations: evidenceLocations,
                remediation,
                fingerprint
            });
            continue;
        }

        items.push(buildArtifactItem({
            item,
            status: materializationStatusForNonFollowUpItem(item),
            taskId: null,
            fingerprint,
            title,
            description,
            evidenceLocations,
            remediation
        }));
    }

    return { obligations, items, violations };
}

function materializationStatusForNonFollowUpItem(
    item: ReviewFindingsDispositionArtifactItem
): ReviewFindingFollowUpItemStatus {
    return item.action === 'fix_now' ? 'requires_fix_now' : 'not_required';
}

function blockedStatusForDispositionItem(
    item: ReviewFindingsDispositionArtifactItem
): ReviewFindingFollowUpItemStatus {
    return item.action === 'create_follow_up'
        ? 'blocked'
        : materializationStatusForNonFollowUpItem(item);
}

function buildArtifactItem(params: {
    item: ReviewFindingsDispositionArtifactItem;
    status: ReviewFindingFollowUpItemStatus;
    taskId: string | null;
    fingerprint: string | null;
    title: string | null;
    description: string | null;
    evidenceLocations: readonly string[];
    remediation: string | null;
}): ReviewFindingsFollowUpTaskMaterializationItem {
    return {
        source_item_id: params.item.id,
        source_item_kind: params.item.kind,
        severity: params.item.severity,
        action: params.item.action,
        source_rule: params.item.source_rule,
        source_policy: params.item.policy_source,
        blocking: params.item.blocking,
        fingerprint: params.fingerprint,
        materialization_status: params.status,
        task_id: params.taskId,
        title: params.title,
        description: params.description,
        evidence_locations: [...params.evidenceLocations],
        remediation: params.remediation
    };
}

function sanitizeTaskCell(value: unknown, fallback: string, maxLength = 180): string {
    const text = String(value || '').trim() || fallback;
    const compact = text
        .replace(/[\u0000-\u001F\u007F]/gu, ' ')
        .replace(/\|/gu, '/')
        .replace(/\s+/gu, ' ')
        .trim();
    if (compact.length <= maxLength) {
        return compact;
    }
    return `${compact.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function priorityForSeverity(severity: ReviewFindingsDispositionArtifactItem['severity'], fallback: string): string {
    if (severity === 'critical' || severity === 'high') {
        return 'P1';
    }
    if (severity === 'medium' || severity === 'residual_risk') {
        return 'P2';
    }
    if (severity === 'low') {
        return 'P3';
    }
    return fallback || 'P2';
}

function evidenceNote(evidenceLocations: readonly string[]): string {
    const firstLocations = evidenceLocations.slice(0, 3).map((entry) => sanitizeTaskCell(entry, 'unknown evidence', 80));
    if (firstLocations.length === 0) {
        return 'none recorded';
    }
    const suffix = evidenceLocations.length > firstLocations.length
        ? `, +${evidenceLocations.length - firstLocations.length} more`
        : '';
    return `${firstLocations.join(', ')}${suffix}`;
}

function buildTaskTitle(reviewType: string, obligation: FollowUpObligation): string {
    const severity = obligation.disposition_item.severity === 'residual_risk'
        ? 'residual risk'
        : obligation.disposition_item.severity;
    return sanitizeTaskCell(
        `[${reviewType}] Follow up ${severity} ${obligation.disposition_item.id}: ${obligation.title}`,
        `Follow up ${reviewType} review finding ${obligation.disposition_item.id}`,
        140
    );
}

function buildTaskNotes(params: {
    parentTaskId: string;
    reviewType: string;
    obligation: FollowUpObligation;
    validationArtifactSha256: string;
    validationResultSha256: string;
    dispositionArtifactSha256: string;
    dispositionResultSha256: string;
    receiptSha256: string;
    taskProfile: string;
    taskProfileSource: string;
}): string {
    const item = params.obligation.disposition_item;
    return sanitizeTaskCell([
        `Child of \`${params.parentTaskId}\`.`,
        `Follow-up from accepted \`${params.reviewType}\` ${item.kind} \`${item.id}\` severity \`${item.severity}\`.`,
        `Evidence: ${evidenceNote(params.obligation.evidence_locations)}.`,
        `Remediation: ${params.obligation.remediation}`,
        `validation_sha256=${params.validationArtifactSha256};`,
        `validation_result_sha256=${params.validationResultSha256};`,
        `receipt_sha256=${params.receiptSha256};`,
        `disposition_sha256=${params.dispositionArtifactSha256};`,
        `disposition_result_sha256=${params.dispositionResultSha256};`,
        `review_follow_up_task_profile=${params.taskProfile};`,
        `review_follow_up_task_profile_source=${params.taskProfileSource};`,
        `review_follow_up_fingerprint=${params.obligation.fingerprint}.`
    ].join(' '), 'Review follow-up task.', 1200);
}

function extractGroupedFingerprint(notes: string): string | null {
    return normalizeHash(String(notes || '').match(/review_follow_up_group_fingerprint=([0-9a-f]{64})/iu)?.[1] || null);
}

interface GroupedLaneBinding {
    reviewType: string;
    itemCount: number;
    itemFingerprintsSha256: string;
    sourceBindingSha256: string;
    artifactPath: string | null;
}

function buildGroupedSourceBindingSha256(params: {
    reviewType: string;
    validationArtifactSha256: string;
    validationResultSha256: string;
    dispositionArtifactSha256: string;
    dispositionResultSha256: string;
    receiptSha256: string;
}): string {
    return sha256JsonPayload({
        schema_version: 1,
        review_type: params.reviewType,
        validation_artifact_sha256: params.validationArtifactSha256,
        validation_result_sha256: params.validationResultSha256,
        receipt_sha256: params.receiptSha256,
        disposition_artifact_sha256: params.dispositionArtifactSha256,
        disposition_result_sha256: params.dispositionResultSha256
    });
}

function extractGroupedLaneBindings(notes: string): Map<string, GroupedLaneBinding> {
    const bindings = new Map<string, GroupedLaneBinding>();
    const artifactPaths = new Map<string, string>();
    const artifactMatcher = /review_follow_up_lane_artifact=([a-z0-9_-]+):`([^`\r\n]+)`\./giu;
    for (const match of String(notes || '').matchAll(artifactMatcher)) {
        artifactPaths.set(match[1].toLowerCase(), normalizePath(match[2]));
    }
    const matcher = /review_follow_up_lane_binding=([a-z0-9_-]+):([0-9]+):([0-9a-f]{64}):([0-9a-f]{64})\./giu;
    for (const match of String(notes || '').matchAll(matcher)) {
        const itemCount = Number.parseInt(match[2], 10);
        const itemFingerprintsSha256 = normalizeHash(match[3]);
        const sourceBindingSha256 = normalizeHash(match[4]);
        if (Number.isSafeInteger(itemCount) && itemCount >= 0 && itemFingerprintsSha256 && sourceBindingSha256) {
            bindings.set(match[1].toLowerCase(), {
                reviewType: match[1].toLowerCase(),
                itemCount,
                itemFingerprintsSha256,
                sourceBindingSha256,
                artifactPath: artifactPaths.get(match[1].toLowerCase()) || null
            });
        }
    }
    return bindings;
}

function buildGroupedTaskNotes(params: {
    parentTaskId: string;
    context: FollowUpMaterializationContext;
    reviewType: string;
    obligations: readonly FollowUpObligation[];
    validationArtifactSha256: string;
    validationResultSha256: string;
    dispositionArtifactSha256: string;
    dispositionResultSha256: string;
    receiptSha256: string;
    artifactPath: string;
    existingNotes?: string;
}): string {
    const bindings = extractGroupedLaneBindings(normalizeText(params.existingNotes));
    const reviewType = params.reviewType.toLowerCase();
    const itemFingerprints = [...new Set(params.obligations.map((obligation) => obligation.fingerprint))].sort();
    bindings.set(reviewType, {
        reviewType,
        itemCount: itemFingerprints.length,
        itemFingerprintsSha256: sha256JsonPayload(itemFingerprints),
        sourceBindingSha256: buildGroupedSourceBindingSha256(params),
        artifactPath: normalizePath(params.artifactPath)
    });
    const base = [
        `Child of \`${params.parentTaskId}\`.`,
        'Grouped deferred review findings and residual risks for one task-owned review cycle.',
        `review_follow_up_group_fingerprint=${params.context.group_fingerprint}.`,
        `review_follow_up_snapshot_sha256=${params.context.snapshot_hash}.`,
        `review_follow_up_cycle=${params.context.cycle_id}.`,
        `review_follow_up_task_profile=${params.context.task_profile}.`,
        `review_follow_up_task_profile_source=${params.context.task_profile_source}.`
    ].join(' ');
    const laneBindings = [...bindings.values()]
        .sort((left, right) => left.reviewType.localeCompare(right.reviewType))
        .flatMap((binding) => [
            `review_follow_up_lane_binding=${binding.reviewType}:${binding.itemCount}:` +
            `${binding.itemFingerprintsSha256}:${binding.sourceBindingSha256}.`,
            ...(binding.artifactPath
                ? [`review_follow_up_lane_artifact=${binding.reviewType}:\`${binding.artifactPath}\`.`]
                : [])
        ]);
    // Full per-item evidence remains in the hash-bound follow-up artifact. TASK.md
    // stores one fixed-size digest per review lane, so queue navigation cost is
    // bounded by the configured lane set instead of the number of findings.
    return sanitizeTaskCell([
        base,
        ...laneBindings
    ].join(' '), 'Grouped review follow-up task.', 4096);
}

function extractExistingFingerprint(notes: string): string | null {
    return normalizeHash(String(notes || '').match(/review_follow_up_fingerprint=([0-9a-f]{64})/iu)?.[1] || null);
}

function isParentFollowUpTaskId(parentTaskId: string, taskId: string): boolean {
    const prefix = `${parentTaskId}-F`;
    if (!taskId.startsWith(prefix)) {
        return false;
    }
    return /^[1-9][0-9]*$/u.test(taskId.slice(prefix.length));
}

function appendParentFollowUpNote(existingNotes: string, childTaskIds: readonly string[], artifactPath: string): string {
    const newTaskIds = childTaskIds.filter((taskId) => !existingNotes.includes(taskId));
    const normalizedArtifactPath = normalizePath(artifactPath);
    const artifactAlreadyLinked = existingNotes.includes(`artifact \`${normalizedArtifactPath}\`.`);
    if (newTaskIds.length === 0 && artifactAlreadyLinked) {
        return existingNotes;
    }
    const linkedTaskIds = newTaskIds.length > 0 ? newTaskIds : [...new Set(childTaskIds)];
    if (linkedTaskIds.length === 0) {
        return existingNotes;
    }
    const suffix = `Review follow-up tasks materialized: ${linkedTaskIds.map((taskId) => `\`${taskId}\``).join(', ')}; artifact \`${normalizedArtifactPath}\`.`;
    return existingNotes.trim() ? `${existingNotes.trim()} ${suffix}` : suffix;
}

function sourceParentNotes(notes: string): string {
    return String(notes || '').replace(MATERIALIZED_PARENT_NOTE_SUFFIX_PATTERN, '').trim();
}

function findInsertionLineIndex(parentRow: CanonicalActiveTaskQueueRow, rows: readonly CanonicalActiveTaskQueueRow[]): number {
    const prefix = `${parentRow.taskId}-F`.toLowerCase();
    return rows.reduce((lineIndex, row) => {
        if (row.taskId.toLowerCase().startsWith(prefix)) {
            return Math.max(lineIndex, row.lineIndex);
        }
        return lineIndex;
    }, parentRow.lineIndex);
}

function materializeTaskQueueRows(params: {
    repoRoot: string;
    parentTaskId: string;
    reviewType: string;
    artifactPath: string;
    obligations: readonly FollowUpObligation[];
    validationArtifactSha256: string;
    validationResultSha256: string;
    dispositionArtifactSha256: string;
    dispositionResultSha256: string;
    receiptSha256: string;
    materializationContext: FollowUpMaterializationContext;
}): TaskQueueMaterializationResult {
    const taskPath = path.join(params.repoRoot, TASK_QUEUE_FILENAME);
    if (params.obligations.length === 0) {
        return {
            outcome: 'not_required',
            task_path: normalizePath(taskPath),
            created: [],
            reused: [],
            blocked_fingerprints: [],
            error_message: null,
            rollback_content: null
        };
    }
    if (!fs.existsSync(taskPath) || !fs.statSync(taskPath).isFile()) {
        return {
            outcome: 'task_file_missing',
            task_path: normalizePath(taskPath),
            created: [],
            reused: [],
            blocked_fingerprints: params.obligations.map((obligation) => obligation.fingerprint),
            error_message: null,
            rollback_content: null
        };
    }

    return withTaskQueueStatusSyncLock<TaskQueueMaterializationResult>(
        taskPath,
        (message) => ({
            outcome: 'write_failed',
            task_path: normalizePath(taskPath),
            created: [],
            reused: [],
            blocked_fingerprints: params.obligations.map((obligation) => obligation.fingerprint),
            error_message: message,
            rollback_content: null
        }),
        () => {
            const original = fs.readFileSync(taskPath, 'utf8');
            const newline = original.includes('\r\n') ? '\r\n' : '\n';
            const lines = original.split(/\r?\n/);
            const parsed = parseCanonicalActiveTaskQueue(original);
            if (!parsed.found) {
                return {
                    outcome: 'write_failed',
                    task_path: normalizePath(taskPath),
                    created: [],
                    reused: [],
                    blocked_fingerprints: params.obligations.map((obligation) => obligation.fingerprint),
                    error_message: parsed.unavailableReason || 'Canonical Active Queue table not found.',
                    rollback_content: null
                };
            }
            const parentRow = parsed.rows.find((row) => row.taskId === params.parentTaskId);
            if (!parentRow) {
                return {
                    outcome: 'task_not_found',
                    task_path: normalizePath(taskPath),
                    created: [],
                    reused: [],
                    blocked_fingerprints: params.obligations.map((obligation) => obligation.fingerprint),
                    error_message: null,
                    rollback_content: null
                };
            }
            const closurePolicy = params.materializationContext.review_follow_up_task_closure_policy;
            if (
                isReviewFindingsFollowUpTaskId(params.parentTaskId)
                && closurePolicy.eligible
            ) {
                const expectedSourceNotesSha256 = normalizeHash(closurePolicy.source_notes_sha256);
                const currentNotesSha256 = sha256TextPayload(parentRow.notes);
                const preMaterializationNotesSha256 = sha256TextPayload(sourceParentNotes(parentRow.notes));
                const matchesCurrentCycle = expectedSourceNotesSha256 === currentNotesSha256;
                const matchesIdempotentRerun = expectedSourceNotesSha256 === preMaterializationNotesSha256;
                if (!expectedSourceNotesSha256 || (!matchesCurrentCycle && !matchesIdempotentRerun)) {
                    return {
                        outcome: 'write_failed',
                        task_path: normalizePath(taskPath),
                        created: [],
                        reused: [],
                        blocked_fingerprints: params.obligations.map((obligation) => obligation.fingerprint),
                        error_message:
                            `Current TASK.md parent notes for '${params.parentTaskId}' do not match the frozen ` +
                            'review follow-up closure-policy source_notes_sha256; descendant materialization is blocked.',
                        rollback_content: null
                    };
                }
            }
            const childTaskProfile = params.materializationContext.task_profile || parentRow.profile;

            if (params.materializationContext.mode === 'grouped_by_parent') {
                const groupFingerprint = params.materializationContext.group_fingerprint;
                if (!groupFingerprint) {
                    return {
                        outcome: 'write_failed',
                        task_path: normalizePath(taskPath),
                        created: [],
                        reused: [],
                        blocked_fingerprints: params.obligations.map((obligation) => obligation.fingerprint),
                        error_message: 'Grouped materialization context is missing its deterministic group fingerprint.',
                        rollback_content: null
                    };
                }
                const groupedRow = parsed.rows.find((row) => (
                    isParentFollowUpTaskId(params.parentTaskId, row.taskId)
                    && extractGroupedFingerprint(row.notes) === groupFingerprint
                ));
                if (groupedRow) {
                    if (!/TODO/iu.test(groupedRow.status)) {
                        return {
                            outcome: 'write_failed',
                            task_path: normalizePath(taskPath),
                            created: [],
                            reused: [],
                            blocked_fingerprints: params.obligations.map((obligation) => obligation.fingerprint),
                            error_message: `Grouped follow-up task '${groupedRow.taskId}' is no longer pending and must not be mutated.`,
                            rollback_content: null
                        };
                    }
                    const nextNotes = buildGroupedTaskNotes({
                        parentTaskId: params.parentTaskId,
                        context: params.materializationContext,
                        reviewType: params.reviewType,
                        obligations: params.obligations,
                        validationArtifactSha256: params.validationArtifactSha256,
                        validationResultSha256: params.validationResultSha256,
                        dispositionArtifactSha256: params.dispositionArtifactSha256,
                        dispositionResultSha256: params.dispositionResultSha256,
                        receiptSha256: params.receiptSha256,
                        artifactPath: normalizePath(path.relative(params.repoRoot, params.artifactPath)),
                        existingNotes: groupedRow.notes
                    });
                    const highestPriority = [
                        groupedRow.priority,
                        ...params.obligations.map((obligation) => (
                            priorityForSeverity(obligation.disposition_item.severity, parentRow.priority)
                        ))
                    ].sort()[0] || parentRow.priority;
                    const priorityUpdatedLine = replaceTaskMdTableCell(
                        groupedRow.rawLine,
                        2,
                        ` ${highestPriority} `
                    );
                    const updatedLine = priorityUpdatedLine
                        ? replaceTaskMdTableCell(priorityUpdatedLine, 8, ` ${nextNotes} `)
                        : null;
                    if (!updatedLine) {
                        return {
                            outcome: 'write_failed',
                            task_path: normalizePath(taskPath),
                            created: [],
                            reused: [],
                            blocked_fingerprints: params.obligations.map((obligation) => obligation.fingerprint),
                            error_message: 'Failed to update grouped TASK.md follow-up priority and notes.',
                            rollback_content: null
                        };
                    }
                    lines[groupedRow.lineIndex] = updatedLine;
                    const nextParentNotes = appendParentFollowUpNote(
                        parentRow.notes,
                        [groupedRow.taskId],
                        params.artifactPath
                    );
                    const updatedParentLine = replaceTaskMdTableCell(
                        parentRow.rawLine,
                        8,
                        ` ${nextParentNotes} `
                    );
                    if (!updatedParentLine) {
                        return {
                            outcome: 'write_failed',
                            task_path: normalizePath(taskPath),
                            created: [],
                            reused: [],
                            blocked_fingerprints: params.obligations.map((obligation) => obligation.fingerprint),
                            error_message: 'Failed to update grouped TASK.md parent artifact registry.',
                            rollback_content: null
                        };
                    }
                    lines[parentRow.lineIndex] = updatedParentLine;
                    const nextContent = formatActiveTaskQueueTable(lines.join(newline));
                    if (nextContent !== original) {
                        fs.writeFileSync(taskPath, nextContent, 'utf8');
                    }
                    return {
                        outcome: nextContent === original ? 'already_materialized' : 'updated',
                        task_path: normalizePath(taskPath),
                        created: [],
                        reused: params.obligations.map((obligation) => ({
                            task_id: groupedRow.taskId,
                            fingerprint: obligation.fingerprint
                        })),
                        blocked_fingerprints: [],
                        error_message: null,
                        rollback_content: nextContent !== original ? original : null
                    };
                }

                const [groupedTaskId] = allocateParentDerivedTaskIds({
                    parentTaskId: params.parentTaskId,
                    existingTaskIds: parsed.rows.map((row) => row.taskId),
                    kind: 'followup',
                    count: 1
                });
                const highestPriority = params.obligations
                    .map((obligation) => priorityForSeverity(obligation.disposition_item.severity, parentRow.priority))
                    .sort()[0] || parentRow.priority;
                const groupedNotes = buildGroupedTaskNotes({
                    parentTaskId: params.parentTaskId,
                    context: params.materializationContext,
                    reviewType: params.reviewType,
                    obligations: params.obligations,
                    validationArtifactSha256: params.validationArtifactSha256,
                    validationResultSha256: params.validationResultSha256,
                    dispositionArtifactSha256: params.dispositionArtifactSha256,
                    dispositionResultSha256: params.dispositionResultSha256,
                    receiptSha256: params.receiptSha256,
                    artifactPath: normalizePath(path.relative(params.repoRoot, params.artifactPath))
                });
                const groupedTaskLine = `| ${[
                    groupedTaskId,
                    'TODO',
                    highestPriority,
                    sanitizeTaskCell(parentRow.area, 'workflow/review-follow-up-tasks', 80),
                    'Address grouped deferred review findings and residual risks',
                    sanitizeTaskCell(parentRow.owner, 'gpt-5.5', 80),
                    nowIso().slice(0, 10),
                    sanitizeTaskCell(childTaskProfile, parentRow.profile || 'balanced', 40),
                    groupedNotes
                ].join(' | ')} |`;
                const nextParentNotes = appendParentFollowUpNote(parentRow.notes, [groupedTaskId], params.artifactPath);
                const updatedParentLine = replaceTaskMdTableCell(parentRow.rawLine, 8, ` ${nextParentNotes} `);
                if (!updatedParentLine) {
                    return {
                        outcome: 'write_failed',
                        task_path: normalizePath(taskPath),
                        created: [],
                        reused: [],
                        blocked_fingerprints: params.obligations.map((obligation) => obligation.fingerprint),
                        error_message: 'Failed to replace TASK.md parent notes cell.',
                        rollback_content: null
                    };
                }
                lines[parentRow.lineIndex] = updatedParentLine;
                lines.splice(findInsertionLineIndex(parentRow, parsed.rows) + 1, 0, groupedTaskLine);
                const nextContent = formatActiveTaskQueueTable(lines.join(newline));
                fs.writeFileSync(taskPath, nextContent, 'utf8');
                return {
                    outcome: 'updated',
                    task_path: normalizePath(taskPath),
                    created: params.obligations.map((obligation) => ({
                        task_id: groupedTaskId,
                        fingerprint: obligation.fingerprint
                    })),
                    reused: [],
                    blocked_fingerprints: [],
                    error_message: null,
                    rollback_content: original
                };
            }

            const existingByFingerprint = new Map<string, string>();
            for (const row of parsed.rows) {
                if (!isParentFollowUpTaskId(params.parentTaskId, row.taskId)) {
                    continue;
                }
                const fingerprint = extractExistingFingerprint(row.notes);
                if (fingerprint) {
                    existingByFingerprint.set(fingerprint, row.taskId);
                }
            }

            const reused: MaterializedTaskReference[] = [];
            const toCreate: FollowUpObligation[] = [];
            for (const obligation of params.obligations) {
                const existingTaskId = existingByFingerprint.get(obligation.fingerprint);
                if (existingTaskId) {
                    reused.push({
                        task_id: existingTaskId,
                        fingerprint: obligation.fingerprint
                    });
                    continue;
                }
                toCreate.push(obligation);
            }

            const allocatedTaskIds = allocateParentDerivedTaskIds({
                parentTaskId: params.parentTaskId,
                existingTaskIds: parsed.rows.map((row) => row.taskId),
                kind: 'followup',
                count: toCreate.length
            });
            const created: MaterializedTaskReference[] = [];
            const today = nowIso().slice(0, 10);
            const insertedRows = toCreate.map((obligation, index) => {
                const taskId = allocatedTaskIds[index];
                created.push({
                    task_id: taskId,
                    fingerprint: obligation.fingerprint
                });
                const row = [
                    taskId,
                    'TODO',
                    priorityForSeverity(obligation.disposition_item.severity, parentRow.priority),
                    sanitizeTaskCell(parentRow.area, 'workflow/review-follow-up-tasks', 80),
                    buildTaskTitle(params.reviewType, obligation),
                    sanitizeTaskCell(parentRow.owner, 'gpt-5.5', 80),
                    today,
                    sanitizeTaskCell(childTaskProfile, parentRow.profile || 'balanced', 40),
                    buildTaskNotes({
                        parentTaskId: params.parentTaskId,
                        reviewType: params.reviewType,
                        obligation,
                        validationArtifactSha256: params.validationArtifactSha256,
                        validationResultSha256: params.validationResultSha256,
                        dispositionArtifactSha256: params.dispositionArtifactSha256,
                        dispositionResultSha256: params.dispositionResultSha256,
                        receiptSha256: params.receiptSha256,
                        taskProfile: childTaskProfile,
                        taskProfileSource: params.materializationContext.task_profile_source
                    })
                ];
                return `| ${row.join(' | ')} |`;
            });

            if (created.length > 0) {
                const nextParentNotes = appendParentFollowUpNote(
                    parentRow.notes,
                    created.map((item) => item.task_id),
                    params.artifactPath
                );
                const updatedParentLine = replaceTaskMdTableCell(parentRow.rawLine, 8, ` ${nextParentNotes} `);
                if (!updatedParentLine) {
                    return {
                        outcome: 'write_failed',
                        task_path: normalizePath(taskPath),
                        created: [],
                        reused,
                        blocked_fingerprints: toCreate.map((obligation) => obligation.fingerprint),
                        error_message: 'Failed to replace TASK.md parent notes cell.',
                        rollback_content: null
                    };
                }
                lines[parentRow.lineIndex] = updatedParentLine;
                const insertionLineIndex = findInsertionLineIndex(parentRow, parsed.rows);
                lines.splice(insertionLineIndex + 1, 0, ...insertedRows);
            }

            const nextContent = formatActiveTaskQueueTable(lines.join(newline));
            if (nextContent !== original) {
                fs.writeFileSync(taskPath, nextContent, 'utf8');
            }

            return {
                outcome: created.length > 0 ? 'updated' : 'already_materialized',
                task_path: normalizePath(taskPath),
                created,
                reused,
                blocked_fingerprints: [],
                error_message: null,
                rollback_content: nextContent !== original ? original : null
            };
        }
    );
}

function rollbackTaskQueueRows(taskPath: string, rollbackContent: string | null): string | null {
    if (rollbackContent === null) {
        return null;
    }
    return withTaskQueueStatusSyncLock<string | null>(
        taskPath,
        (message) => `TASK.md rollback failed after follow-up artifact write failure: ${message}.`,
        () => {
            fs.writeFileSync(taskPath, rollbackContent, 'utf8');
            return null;
        }
    );
}

function buildMaterializationItems(params: {
    baseItems: readonly ReviewFindingsFollowUpTaskMaterializationItem[];
    obligations: readonly FollowUpObligation[];
    queueResult: TaskQueueMaterializationResult | null;
}): ReviewFindingsFollowUpTaskMaterializationItem[] {
    const created = new Map((params.queueResult?.created || []).map((item) => [item.fingerprint, item.task_id]));
    const reused = new Map((params.queueResult?.reused || []).map((item) => [item.fingerprint, item.task_id]));
    const blockedFingerprints = new Set(params.queueResult?.blocked_fingerprints || []);
    const obligationItems = params.obligations.map((obligation) => {
        const taskId = created.get(obligation.fingerprint) || reused.get(obligation.fingerprint) || null;
        const status: ReviewFindingFollowUpItemStatus = created.has(obligation.fingerprint)
            ? 'created'
            : (reused.has(obligation.fingerprint)
                ? 'already_materialized'
                : (blockedFingerprints.has(obligation.fingerprint) ? 'blocked' : 'blocked'));
        return buildArtifactItem({
            item: obligation.disposition_item,
            status,
            taskId,
            fingerprint: obligation.fingerprint,
            title: obligation.title,
            description: obligation.description,
            evidenceLocations: obligation.evidence_locations,
            remediation: obligation.remediation
        });
    });
    return [...params.baseItems, ...obligationItems].sort((left, right) => (
        `${left.source_item_kind}:${left.source_item_id}`.localeCompare(`${right.source_item_kind}:${right.source_item_id}`)
    ));
}

function toValidationStatus(artifact: ReviewFindingsValidationArtifact | null): 'accepted' | 'rejected' | 'unknown' {
    if (!artifact) {
        return 'unknown';
    }
    return artifact.validation_result.status;
}

function buildArtifact(params: {
    repoRoot: string;
    taskId: string;
    reviewType: string;
    status: ReviewFollowUpMaterializationStatus;
    dispositionArtifactPath: string;
    dispositionArtifactSha256: string | null;
    dispositionResultSha256: string | null;
    validationArtifactPath: string | null;
    validationArtifactSha256: string | null;
    validationResultSha256: string | null;
    validationArtifact: ReviewFindingsValidationArtifact | null;
    receiptPath: string | null;
    receiptSha256: string | null;
    items: readonly ReviewFindingsFollowUpTaskMaterializationItem[];
    violations: readonly string[];
}): ReviewFindingsFollowUpTasksArtifact {
    const createdTaskCount = new Set(params.items
        .filter((item) => item.materialization_status === 'created')
        .map((item) => item.task_id)
        .filter(Boolean)).size;
    const reusedTaskCount = new Set(params.items
        .filter((item) => item.materialization_status === 'already_materialized')
        .map((item) => item.task_id)
        .filter(Boolean)).size;
    const blockedTaskCount = params.items.filter((item) => (
        item.materialization_status === 'blocked'
        || item.materialization_status === 'requires_fix_now'
    )).length;
    const notRequiredCount = params.items.filter((item) => item.materialization_status === 'not_required').length;
    return {
        schema_version: REVIEW_FINDINGS_FOLLOW_UP_TASKS_ARTIFACT_SCHEMA_VERSION,
        artifact_type: REVIEW_FINDINGS_FOLLOW_UP_TASKS_ARTIFACT_TYPE,
        task_id: params.taskId,
        review_type: params.reviewType,
        status: params.status,
        created_at_utc: nowIso(),
        materialization_policy: resolveFollowUpMaterializationContext(
            params.repoRoot,
            path.dirname(params.dispositionArtifactPath),
            params.taskId
        ),
        source_disposition: {
            artifact_path: normalizePath(params.dispositionArtifactPath),
            artifact_sha256: params.dispositionArtifactSha256,
            disposition_result_sha256: params.dispositionResultSha256
        },
        source_validation: {
            artifact_path: params.validationArtifactPath ? normalizePath(params.validationArtifactPath) : null,
            artifact_sha256: params.validationArtifactSha256,
            validation_result_sha256: params.validationResultSha256,
            status: toValidationStatus(params.validationArtifact),
            accepted: params.validationArtifact ? params.validationArtifact.validation_result.accepted : null
        },
        source_receipt: {
            receipt_path: params.receiptPath ? normalizePath(params.receiptPath) : null,
            receipt_sha256: params.receiptSha256
        },
        items: [...params.items],
        summary: {
            item_count: params.items.length,
            follow_up_obligation_count: params.items.filter((item) => item.action === 'create_follow_up').length,
            created_task_count: createdTaskCount,
            reused_task_count: reusedTaskCount,
            blocked_task_count: blockedTaskCount,
            not_required_count: notRequiredCount
        },
        violations: [...params.violations]
    };
}

function deriveReceiptPath(params: {
    repoRoot: string;
    explicitReceiptPath?: string | null;
    validationArtifact: ReviewFindingsValidationArtifact | null;
    dispositionArtifactPath: string;
}): string | null {
    if (params.explicitReceiptPath) {
        return resolveInputPathInsideRepo(params.repoRoot, params.explicitReceiptPath, 'ReceiptPath');
    }
    const reviewArtifactPath = normalizeText(
        params.validationArtifact?.validation_result.bindings.output.review_artifact_path || ''
    );
    if (reviewArtifactPath && /\.md$/u.test(reviewArtifactPath)) {
        return resolveInputPathInsideRepo(params.repoRoot, reviewArtifactPath, 'ReviewArtifactPath')
            .replace(/\.md$/u, '-receipt.json');
    }
    if (/-findings-disposition\.json$/u.test(params.dispositionArtifactPath)) {
        return params.dispositionArtifactPath.replace(/-findings-disposition\.json$/u, '-receipt.json');
    }
    return null;
}

function hasFixNowMaterializationItems(
    items: readonly ReviewFindingsFollowUpTaskMaterializationItem[]
): boolean {
    return items.some((item) => item.materialization_status === 'requires_fix_now');
}

function validateHashField(
    violations: string[],
    subject: string,
    actual: unknown,
    expected: string | null
): void {
    const normalizedActual = normalizeHash(actual);
    if (!expected) {
        return;
    }
    if (normalizedActual !== expected) {
        violations.push(`${subject} mismatch: expected ${expected}, found ${normalizedActual || 'missing'}.`);
    }
}

function validatePathField(
    violations: string[],
    subject: string,
    actual: unknown,
    expectedPath: string
): void {
    const actualText = normalizeText(actual);
    if (!actualText) {
        violations.push(`${subject} is missing.`);
        return;
    }
    const normalizedActual = normalizePath(path.isAbsolute(actualText) ? path.resolve(actualText) : actualText);
    const normalizedExpected = normalizePath(expectedPath);
    if (normalizedActual !== normalizedExpected) {
        violations.push(`${subject} mismatch: expected ${normalizedExpected}, found ${normalizedActual}.`);
    }
}

function validateReceiptEvidence(params: {
    receipt: Record<string, unknown> | null;
    receiptPath: string | null;
    taskId: string;
    reviewType: string;
    validationArtifactPath: string;
    validationArtifactSha256: string | null;
    validationResultSha256: string | null;
    dispositionArtifactPath: string;
    dispositionArtifactSha256: string | null;
    dispositionResultSha256: string | null;
}): { receiptSha256: string | null; violations: string[] } {
    const violations: string[] = [];
    const receiptSha256 = params.receiptPath ? fileSha256(params.receiptPath) : null;
    if (!params.receiptPath || !params.receipt) {
        return {
            receiptSha256,
            violations: ['Review receipt is required to carry receipt hash evidence for materialized follow-up tasks.']
        };
    }
    if (normalizeText(params.receipt.task_id) !== params.taskId) {
        violations.push(`Review receipt task_id mismatch: expected ${params.taskId}, found ${normalizeText(params.receipt.task_id) || 'missing'}.`);
    }
    if (normalizeText(params.receipt.review_type) !== params.reviewType) {
        violations.push(`Review receipt review_type mismatch: expected ${params.reviewType}, found ${normalizeText(params.receipt.review_type) || 'missing'}.`);
    }
    const validationReference = isPlainRecord(params.receipt.review_findings_validation)
        ? params.receipt.review_findings_validation
        : null;
    if (!validationReference) {
        violations.push('Review receipt is missing review_findings_validation evidence.');
    } else {
        validatePathField(violations, 'Review receipt review_findings_validation.artifact_path', validationReference.artifact_path, normalizePath(params.validationArtifactPath));
        validateHashField(violations, 'Review receipt review_findings_validation.artifact_sha256', validationReference.artifact_sha256, params.validationArtifactSha256);
        validateHashField(violations, 'Review receipt review_findings_validation.validation_result_sha256', validationReference.validation_result_sha256, params.validationResultSha256);
        if (validationReference.accepted !== true) {
            violations.push('Review receipt review_findings_validation.accepted must be true.');
        }
        if (validationReference.status !== 'accepted') {
            violations.push('Review receipt review_findings_validation.status must be accepted.');
        }
    }
    const dispositionReference = isPlainRecord(params.receipt.review_findings_disposition_artifact)
        ? params.receipt.review_findings_disposition_artifact
        : null;
    if (!dispositionReference) {
        violations.push('Review receipt is missing review_findings_disposition_artifact evidence.');
    } else {
        validatePathField(violations, 'Review receipt review_findings_disposition_artifact.artifact_path', dispositionReference.artifact_path, normalizePath(params.dispositionArtifactPath));
        validateHashField(violations, 'Review receipt review_findings_disposition_artifact.artifact_sha256', dispositionReference.artifact_sha256, params.dispositionArtifactSha256);
        validateHashField(violations, 'Review receipt review_findings_disposition_artifact.disposition_result_sha256', dispositionReference.disposition_result_sha256, params.dispositionResultSha256);
    }
    const embeddedDisposition = isPlainRecord(params.receipt.review_findings_disposition)
        ? params.receipt.review_findings_disposition
        : null;
    if (!embeddedDisposition) {
        violations.push('Review receipt is missing review_findings_disposition evidence.');
    } else {
        validateHashField(
            violations,
            'Review receipt review_findings_disposition payload sha256',
            sha256RedactedJsonPayload(embeddedDisposition),
            params.dispositionResultSha256
        );
    }
    const contract = isPlainRecord(params.receipt.review_output_contract)
        ? params.receipt.review_output_contract
        : null;
    if (!contract) {
        violations.push('Review receipt is missing review_output_contract evidence.');
    } else {
        validateHashField(violations, 'Review receipt review_output_contract.validation_artifact_sha256', contract.validation_artifact_sha256, params.validationArtifactSha256);
        validateHashField(violations, 'Review receipt review_output_contract.validation_result_sha256', contract.validation_result_sha256, params.validationResultSha256);
        validateHashField(violations, 'Review receipt review_output_contract.disposition_artifact_sha256', contract.disposition_artifact_sha256, params.dispositionArtifactSha256);
        validateHashField(violations, 'Review receipt review_output_contract.disposition_result_sha256', contract.disposition_result_sha256, params.dispositionResultSha256);
    }
    return { receiptSha256, violations };
}

function validateDispositionClosurePolicyBinding(params: {
    disposition: ReviewFindingsDispositionArtifact;
    materializationContext: FollowUpMaterializationContext;
}): string[] {
    const policy = params.disposition.policy as unknown as Record<string, unknown>;
    const dispositionClosurePolicy = policy.review_follow_up_task_closure_policy;
    const currentClosurePolicy = params.materializationContext.review_follow_up_task_closure_policy;
    if (dispositionClosurePolicy === undefined) {
        return currentClosurePolicy.eligible || currentClosurePolicy.configured
            ? [
                'Review findings disposition artifact is missing the frozen follow-up task closure-policy binding.'
            ]
            : [];
    }
    const violations = getReviewFollowUpTaskClosurePolicySnapshotViolations(dispositionClosurePolicy);
    if (violations.length > 0) {
        return violations.map((violation) => (
            `Review findings disposition closure-policy binding ${violation}`
        ));
    }
    if (sha256JsonPayload(dispositionClosurePolicy) !== sha256JsonPayload(currentClosurePolicy)) {
        return [
            'Review findings disposition closure-policy snapshot does not match the frozen current preflight snapshot.'
        ];
    }
    return [];
}

function validateGroupedSourceCycleEvidence(params: {
    repoRoot: string;
    reviewsRoot: string;
    taskId: string;
    reviewType: string;
    materializationContext: FollowUpMaterializationContext;
    validationArtifact: ReviewFindingsValidationArtifact;
    receipt: Record<string, unknown> | null;
}): string[] {
    if (params.materializationContext.mode !== 'grouped_by_parent') {
        return [];
    }
    const violations: string[] = [];
    const expectedPreflightSha256 = params.materializationContext.preflight_sha256;
    const expectedCompileTimestamp = params.materializationContext.compile_gate_timestamp;
    if (!expectedPreflightSha256 || !expectedCompileTimestamp) {
        return ['Grouped follow-up source evidence cannot be bound because the current materialization cycle is incomplete.'];
    }

    validateHashField(
        violations,
        'Review findings validation preflight_sha256',
        params.validationArtifact.validation_result.bindings.scope.preflight_sha256,
        expectedPreflightSha256
    );
    validateHashField(
        violations,
        'Review receipt preflight_sha256',
        params.receipt?.preflight_sha256,
        expectedPreflightSha256
    );

    const contextBinding = params.validationArtifact.validation_result.bindings.context;
    const contextPathText = normalizeText(contextBinding.review_context_path);
    const expectedContextSha256 = normalizeHash(contextBinding.review_context_sha256);
    if (!contextPathText || !expectedContextSha256) {
        violations.push('Grouped follow-up source validation is missing its review context path or sha256 binding.');
        return violations;
    }

    let contextPath: string;
    try {
        contextPath = resolveInputPathInsideRepo(params.repoRoot, contextPathText, 'ReviewContextPath');
    } catch (error: unknown) {
        violations.push(error instanceof Error ? error.message : String(error));
        return violations;
    }
    const normalizedReviewsRoot = `${normalizePath(path.resolve(params.reviewsRoot)).replace(/\/$/u, '')}/`;
    if (!normalizePath(contextPath).startsWith(normalizedReviewsRoot)) {
        violations.push(`ReviewContextPath must stay inside the reviews root: ${normalizedReviewsRoot}`);
        return violations;
    }
    const contextRead = readJsonFile(contextPath, 'Review context artifact');
    violations.push(...contextRead.violations);
    validateHashField(
        violations,
        'Review context artifact sha256',
        fileSha256(contextPath),
        expectedContextSha256
    );
    validateHashField(
        violations,
        'Review receipt review_context_sha256',
        params.receipt?.review_context_sha256,
        expectedContextSha256
    );
    if (!contextRead.value) {
        return violations;
    }
    if (normalizeText(contextRead.value.task_id) !== params.taskId) {
        violations.push('Review context task_id does not match the grouped follow-up parent task.');
    }
    if (normalizeText(contextRead.value.review_type) !== params.reviewType) {
        violations.push('Review context review_type does not match the grouped follow-up source lane.');
    }
    const preflightPath = path.join(params.reviewsRoot, `${params.taskId}-preflight.json`);
    const preflightRead = readJsonFile(preflightPath, 'Preflight artifact');
    violations.push(...preflightRead.violations);
    if (!preflightRead.value) {
        return violations;
    }
    try {
        const dependencyGraph = resolveCompiledReviewDependencyGraphFromPreflight(preflightRead.value);
        if (
            dependencyGraph
            && (
                dependencyGraph.full_suite_barrier.enabled !== true
                || !dependencyGraph.full_suite_barrier.before_review_ids.includes(params.reviewType)
            )
        ) {
            return violations;
        }
    } catch (error: unknown) {
        violations.push(
            `Grouped follow-up source full-suite policy binding is invalid: ${errorMessage(error)}`
        );
        return violations;
    }
    const fullSuite = isPlainRecord(contextRead.value.full_suite_validation)
        ? contextRead.value.full_suite_validation
        : null;
    const cycleBinding = fullSuite && isPlainRecord(fullSuite.cycle_binding)
        ? fullSuite.cycle_binding
        : null;
    if (!fullSuite || fullSuite.cycle_binding_valid !== true || fullSuite.matches_current_preflight !== true
        || fullSuite.matches_current_compile_gate !== true) {
        violations.push('Review context full-suite evidence is not valid for the current preflight and compile cycle.');
    }
    validateHashField(
        violations,
        'Review context full-suite preflight_sha256',
        cycleBinding?.preflight_sha256,
        expectedPreflightSha256
    );
    const contextCompileTimestamp = normalizeText(
        fullSuite?.compile_gate_timestamp_utc || cycleBinding?.compile_gate_timestamp
    );
    if (contextCompileTimestamp !== expectedCompileTimestamp) {
        violations.push(
            `Review context compile gate timestamp mismatch: expected ${expectedCompileTimestamp}, ` +
            `found ${contextCompileTimestamp || 'missing'}.`
        );
    }
    return violations;
}

function validateGroupedRequiredReviewCompletion(params: {
    repoRoot: string;
    reviewsRoot: string;
    taskId: string;
    reviewType: string;
    materializationContext: FollowUpMaterializationContext;
}): string[] {
    if (params.materializationContext.mode !== 'grouped_by_parent') {
        return [];
    }
    const preflightPath = path.join(params.reviewsRoot, `${params.taskId}-preflight.json`);
    const preflightRead = readJsonFile(preflightPath, 'Preflight artifact');
    if (!preflightRead.value) {
        return [...preflightRead.violations, 'Grouped follow-up materialization requires the current preflight artifact.'];
    }
    const preflightSha256 = fileSha256(preflightPath);
    const eventsRoot = joinOrchestratorPath(params.repoRoot, path.join('runtime', 'task-events'));
    const requiredReviews = isPlainRecord(preflightRead.value.required_reviews)
        ? preflightRead.value.required_reviews
        : {};
    const reviewReadinessViolations: string[] = [];
    const configuredRequiredReviewTypes = Object.keys(requiredReviews)
        .filter((key) => requiredReviews[key] === true)
        .sort();
    if (configuredRequiredReviewTypes.length > 0 && requiredReviews[params.reviewType] !== true) {
        reviewReadinessViolations.push(
            `Grouped follow-up review lane '${params.reviewType}' is not configured in current required_reviews.`
        );
    }
    for (const reviewType of configuredRequiredReviewTypes) {
        const state = readReviewArtifactState(
            params.reviewsRoot,
            params.taskId,
            reviewType,
            preflightPath,
            preflightSha256,
            preflightRead.value,
            params.repoRoot
        );
        if (!state.ready || !reviewStateHasSatisfiedEvidence(
            params.repoRoot,
            eventsRoot,
            params.taskId,
            state
        )) {
            reviewReadinessViolations.push(
                `Grouped follow-up required review lane '${reviewType}' is not complete with independently ` +
                'attested evidence for the current cycle: ' +
                `${state.violations.join(' ') || state.failureReason || 'review evidence is not ready'}.`
            );
        }
    }
    return reviewReadinessViolations;
}

function buildBlockedResult(params: {
    repoRoot: string;
    taskId: string;
    reviewType: string;
    artifactPath: string;
    dispositionArtifactPath: string;
    dispositionArtifactSha256: string | null;
    dispositionResultSha256: string | null;
    validationArtifactPath: string | null;
    validationArtifactSha256: string | null;
    validationResultSha256: string | null;
    validationArtifact: ReviewFindingsValidationArtifact | null;
    receiptPath: string | null;
    receiptSha256: string | null;
    items: readonly ReviewFindingsFollowUpTaskMaterializationItem[];
    violations: readonly string[];
}): ReviewFindingsFollowUpTaskMaterializationResult {
    const violations = [...params.violations];
    const artifact = buildArtifact({
        repoRoot: params.repoRoot,
        taskId: params.taskId,
        reviewType: params.reviewType,
        status: 'BLOCKED',
        dispositionArtifactPath: params.dispositionArtifactPath,
        dispositionArtifactSha256: params.dispositionArtifactSha256,
        dispositionResultSha256: params.dispositionResultSha256,
        validationArtifactPath: params.validationArtifactPath,
        validationArtifactSha256: params.validationArtifactSha256,
        validationResultSha256: params.validationResultSha256,
        validationArtifact: params.validationArtifact,
        receiptPath: params.receiptPath,
        receiptSha256: params.receiptSha256,
        items: params.items,
        violations
    });
    const writeViolation = tryWriteJson(params.artifactPath, artifact, 'Review findings follow-up materialization artifact');
    if (writeViolation) {
        violations.push(writeViolation);
    }
    return {
        status: 'BLOCKED',
        task_id: params.taskId,
        review_type: params.reviewType,
        artifact_path: normalizePath(params.artifactPath),
        created_task_ids: [],
        reused_task_ids: [],
        violations,
        output_lines: formatOutput({
            repoRoot: params.repoRoot,
            taskId: params.taskId,
            status: 'BLOCKED',
            marker: 'REVIEW_FINDINGS_FOLLOW_UP_TASKS_BLOCKED',
            action: 'Resolve review findings follow-up materialization blockers, then rerun this gate.',
            reason: violations.join(' '),
            artifactPath: params.artifactPath,
            violations
        })
    };
}

export function materializeReviewFindingsFollowUpTasks(
    options: MaterializeReviewFindingsFollowUpTasksOptions
): ReviewFindingsFollowUpTaskMaterializationResult {
    const repoRoot = path.resolve(options.repoRoot || '.');
    let taskId = normalizeText(options.taskId);
    let reviewType = normalizeText(options.reviewType).toLowerCase();
    let reviewsRoot = joinOrchestratorPath(repoRoot, path.join('runtime', 'reviews'));
    let dispositionArtifactPath = '';
    let artifactPath = getFallbackArtifactPath(repoRoot, taskId, reviewType);

    try {
        taskId = assertCanonicalTaskId(taskId);
        reviewType = assertReviewTypeToken(reviewType);
        artifactPath = getFallbackArtifactPath(repoRoot, taskId, reviewType);
        reviewsRoot = options.reviewsRoot
            ? resolveInputPathInsideRepo(repoRoot, options.reviewsRoot, 'ReviewsRoot')
            : reviewsRoot;
        dispositionArtifactPath = options.dispositionArtifactPath
            ? resolveInputPathInsideRepo(repoRoot, options.dispositionArtifactPath, 'DispositionArtifactPath')
            : path.join(reviewsRoot, `${taskId}-${reviewType}-findings-disposition.json`);
        artifactPath = options.artifactPath
            ? resolveFollowUpArtifactPath(repoRoot, reviewsRoot, options.artifactPath)
            : resolveFollowUpArtifactPath(
                repoRoot,
                reviewsRoot,
                getReviewFindingsFollowUpTasksArtifactPath(dispositionArtifactPath)
            );
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        const blockedTaskId = isCanonicalTaskId(taskId) ? taskId : 'UNKNOWN-TASK';
        const blockedReviewType = isReviewTypeToken(reviewType) ? assertReviewTypeToken(reviewType) : 'unknown-review';
        return buildBlockedResult({
            repoRoot,
            taskId: blockedTaskId,
            reviewType: blockedReviewType,
            artifactPath,
            dispositionArtifactPath: dispositionArtifactPath || normalizePath(path.resolve(repoRoot, String(options.dispositionArtifactPath || ''))),
            dispositionArtifactSha256: null,
            dispositionResultSha256: null,
            validationArtifactPath: null,
            validationArtifactSha256: null,
            validationResultSha256: null,
            validationArtifact: null,
            receiptPath: null,
            receiptSha256: null,
            items: [],
            violations: [message]
        });
    }

    const dispositionRead = readJsonFile(dispositionArtifactPath, 'Review findings disposition artifact');
    const dispositionArtifactSha256 = fileSha256(dispositionArtifactPath);
    const disposition = dispositionRead.value ? parseDispositionArtifact(dispositionRead.value) : null;
    const parsedDispositionViolations = disposition
        ? validateDispositionArtifactShape({ artifact: disposition, artifactPath: dispositionArtifactPath, taskId, reviewType })
        : ['Review findings disposition artifact has invalid shape.'];
    const initialViolations = [
        ...dispositionRead.violations,
        ...(dispositionRead.value ? parsedDispositionViolations : [])
    ];

    if (!disposition || initialViolations.length > 0 || !dispositionArtifactSha256) {
        return buildBlockedResult({
            repoRoot,
            taskId,
            reviewType,
            artifactPath,
            dispositionArtifactPath,
            dispositionArtifactSha256,
            dispositionResultSha256: disposition?.disposition_result_sha256 || null,
            validationArtifactPath: disposition?.source_validation.artifact_path || null,
            validationArtifactSha256: disposition?.source_validation.artifact_sha256 || null,
            validationResultSha256: disposition?.source_validation.validation_result_sha256 || null,
            validationArtifact: null,
            receiptPath: null,
            receiptSha256: null,
            items: [],
            violations: initialViolations
        });
    }

    let validationArtifactPath = '';
    try {
        validationArtifactPath = resolveInputPathInsideRepo(
            repoRoot,
            disposition.source_validation.artifact_path || '',
            'ValidationArtifactPath'
        );
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return buildBlockedResult({
            repoRoot,
            taskId,
            reviewType,
            artifactPath,
            dispositionArtifactPath,
            dispositionArtifactSha256,
            dispositionResultSha256: disposition.disposition_result_sha256,
            validationArtifactPath: disposition.source_validation.artifact_path || null,
            validationArtifactSha256: disposition.source_validation.artifact_sha256 || null,
            validationResultSha256: disposition.source_validation.validation_result_sha256 || null,
            validationArtifact: null,
            receiptPath: null,
            receiptSha256: null,
            items: [],
            violations: [message]
        });
    }
    const validationResult = validateReviewFindingsValidationArtifact({
        artifactPath: validationArtifactPath,
        expectedTaskId: taskId,
        expectedReviewType: reviewType,
        requireAccepted: true,
        expectedArtifactSha256: disposition.source_validation.artifact_sha256,
        expectedValidationResultSha256: disposition.source_validation.validation_result_sha256
    });
    const validationArtifact = validationResult.artifact;
    let receiptPath: string | null = null;
    try {
        receiptPath = deriveReceiptPath({
            repoRoot,
            explicitReceiptPath: options.receiptPath,
            validationArtifact,
            dispositionArtifactPath
        });
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return buildBlockedResult({
            repoRoot,
            taskId,
            reviewType,
            artifactPath,
            dispositionArtifactPath,
            dispositionArtifactSha256,
            dispositionResultSha256: disposition.disposition_result_sha256,
            validationArtifactPath,
            validationArtifactSha256: validationResult.artifact_sha256,
            validationResultSha256: validationArtifact?.validation_result_sha256 || disposition.source_validation.validation_result_sha256,
            validationArtifact,
            receiptPath: null,
            receiptSha256: null,
            items: [],
            violations: [message]
        });
    }
    const receiptRead = receiptPath
        ? readJsonFile(receiptPath, 'Review receipt')
        : { value: null, violations: ['Review receipt path could not be derived from validation or disposition artifact bindings.'] };
    const receiptValidation = validateReceiptEvidence({
        receipt: receiptRead.value,
        receiptPath,
        taskId,
        reviewType,
        validationArtifactPath,
        validationArtifactSha256: validationResult.artifact_sha256,
        validationResultSha256: validationArtifact?.validation_result_sha256 || null,
        dispositionArtifactPath,
        dispositionArtifactSha256,
        dispositionResultSha256: disposition.disposition_result_sha256
    });
    const materializationContext = resolveFollowUpMaterializationContext(repoRoot, reviewsRoot, taskId);
    const dispositionClosurePolicyViolations = validateDispositionClosurePolicyBinding({
        disposition,
        materializationContext
    });
    const groupedSourceCycleViolations = validationArtifact
        ? validateGroupedSourceCycleEvidence({
            repoRoot,
            reviewsRoot,
            taskId,
            reviewType,
            materializationContext,
            validationArtifact,
            receipt: receiptRead.value
        })
        : [];
    const groupedRequiredReviewViolations = disposition.items.some((item) => item.action === 'create_follow_up')
        ? validateGroupedRequiredReviewCompletion({
            repoRoot,
            reviewsRoot,
            taskId,
            reviewType,
            materializationContext
        })
        : [];
    const validationInventoryViolations = validationArtifact
        ? validateValidationInventoryShape(validationArtifact)
        : [];
    const dispositionInventoryViolations = validationArtifact && validationInventoryViolations.length === 0
        ? validateDispositionInventoryCompleteness({ disposition, validation: validationArtifact })
        : [];
    const sourceViolations = [
        ...validationResult.violations,
        ...validationInventoryViolations,
        ...dispositionInventoryViolations,
        ...receiptRead.violations,
        ...receiptValidation.violations,
        ...dispositionClosurePolicyViolations,
        ...groupedSourceCycleViolations,
        ...groupedRequiredReviewViolations
    ];
    if (validationArtifact && validationArtifact.validation_result.status !== 'accepted') {
        sourceViolations.push(
            `Review findings validation artifact status must be accepted before follow-up materialization; ` +
            `found ${validationArtifact.validation_result.status}.`
        );
    }
    if (validationArtifact && validationArtifact.validation_result.accepted !== true) {
        sourceViolations.push('Review findings validation artifact accepted flag must be true before follow-up materialization.');
    }
    if (!validationArtifact || sourceViolations.length > 0 || !validationResult.artifact_sha256 || !receiptValidation.receiptSha256) {
        return buildBlockedResult({
            repoRoot,
            taskId,
            reviewType,
            artifactPath,
            dispositionArtifactPath,
            dispositionArtifactSha256,
            dispositionResultSha256: disposition.disposition_result_sha256,
            validationArtifactPath,
            validationArtifactSha256: validationResult.artifact_sha256,
            validationResultSha256: validationArtifact?.validation_result_sha256 || disposition.source_validation.validation_result_sha256,
            validationArtifact,
            receiptPath,
            receiptSha256: receiptValidation.receiptSha256,
            items: [],
            violations: sourceViolations
        });
    }

    const built = buildObligations({
        taskId,
        reviewType,
        disposition,
        validation: validationArtifact,
        dispositionArtifactSha256
    });
    if (built.violations.length > 0) {
        return buildBlockedResult({
            repoRoot,
            taskId,
            reviewType,
            artifactPath,
            dispositionArtifactPath,
            dispositionArtifactSha256,
            dispositionResultSha256: disposition.disposition_result_sha256,
            validationArtifactPath,
            validationArtifactSha256: validationResult.artifact_sha256,
            validationResultSha256: validationArtifact.validation_result_sha256,
            validationArtifact,
            receiptPath,
            receiptSha256: receiptValidation.receiptSha256,
            items: built.items,
            violations: built.violations
        });
    }

    const closurePolicy = materializationContext.review_follow_up_task_closure_policy;
    const isFollowUpTask = isReviewFindingsFollowUpTaskId(taskId);
    const legacyNestedFollowUpBlocked = isFollowUpTask
        && (!closurePolicy.eligible || !closurePolicy.valid);
    const descendantMaterializationForbidden = isFollowUpTask
        && (closurePolicy.forbid_child_tasks || legacyNestedFollowUpBlocked);
    if (descendantMaterializationForbidden && built.obligations.length > 0) {
        const blockedQueueResult: TaskQueueMaterializationResult = {
            outcome: 'not_required',
            task_path: normalizePath(path.join(repoRoot, TASK_QUEUE_FILENAME)),
            created: [],
            reused: [],
            blocked_fingerprints: built.obligations.map((obligation) => obligation.fingerprint),
            error_message: null,
            rollback_content: null
        };
        const items = buildMaterializationItems({
            baseItems: built.items,
            obligations: built.obligations,
            queueResult: blockedQueueResult
        });
        return buildBlockedResult({
            repoRoot,
            taskId,
            reviewType,
            artifactPath,
            dispositionArtifactPath,
            dispositionArtifactSha256,
            dispositionResultSha256: disposition.disposition_result_sha256,
            validationArtifactPath,
            validationArtifactSha256: validationResult.artifact_sha256,
            validationResultSha256: validationArtifact.validation_result_sha256,
            validationArtifact,
            receiptPath,
            receiptSha256: receiptValidation.receiptSha256,
            items,
            violations: [legacyNestedFollowUpBlocked
                ? `Legacy review follow-up task '${taskId}' has no valid explicit closure-policy provenance; ` +
                    'nested follow-up materialization remains fail-closed after receipt, context, and tree evidence validation.'
                : `Frozen review follow-up task closure policy forbids child tasks for '${taskId}'; ` +
                    'every would-be descendant remains an explicit current-task remediation blocker.']
        });
    }

    const hasFixNowItems = hasFixNowMaterializationItems(built.items);
    const queueResult: TaskQueueMaterializationResult = hasFixNowItems
        ? {
            outcome: 'not_required',
            task_path: normalizePath(path.join(repoRoot, TASK_QUEUE_FILENAME)),
            created: [],
            reused: [],
            blocked_fingerprints: built.obligations.map((obligation) => obligation.fingerprint),
            error_message: null,
            rollback_content: null
        }
        : materializeTaskQueueRows({
            repoRoot,
            parentTaskId: taskId,
            reviewType,
            artifactPath,
            obligations: built.obligations,
            validationArtifactSha256: validationResult.artifact_sha256,
            validationResultSha256: validationArtifact.validation_result_sha256,
            dispositionArtifactSha256,
            dispositionResultSha256: disposition.disposition_result_sha256,
            receiptSha256: receiptValidation.receiptSha256,
            materializationContext
        });
    const queueViolations = ['task_file_missing', 'task_not_found', 'write_failed'].includes(queueResult.outcome)
        ? [`TASK.md follow-up task materialization failed: ${queueResult.outcome}${queueResult.error_message ? ` (${queueResult.error_message})` : ''}.`]
        : [];
    const items = buildMaterializationItems({
        baseItems: built.items,
        obligations: built.obligations,
        queueResult
    });
    if (queueViolations.length > 0) {
        return buildBlockedResult({
            repoRoot,
            taskId,
            reviewType,
            artifactPath,
            dispositionArtifactPath,
            dispositionArtifactSha256,
            dispositionResultSha256: disposition.disposition_result_sha256,
            validationArtifactPath,
            validationArtifactSha256: validationResult.artifact_sha256,
            validationResultSha256: validationArtifact.validation_result_sha256,
            validationArtifact,
            receiptPath,
            receiptSha256: receiptValidation.receiptSha256,
            items,
            violations: queueViolations
        });
    }

    const status: ReviewFollowUpMaterializationStatus = hasFixNowItems
        ? 'BLOCKED'
        : (queueResult.outcome === 'not_required'
            ? 'NOT_REQUIRED'
            : (queueResult.created.length > 0 ? 'MATERIALIZED' : 'ALREADY_MATERIALIZED'));
    const artifact = buildArtifact({
        repoRoot,
        taskId,
        reviewType,
        status,
        dispositionArtifactPath,
        dispositionArtifactSha256,
        dispositionResultSha256: disposition.disposition_result_sha256,
        validationArtifactPath,
        validationArtifactSha256: validationResult.artifact_sha256,
        validationResultSha256: validationArtifact.validation_result_sha256,
        validationArtifact,
        receiptPath,
        receiptSha256: receiptValidation.receiptSha256,
        items,
        violations: []
    });
    const artifactWriteViolation = tryWriteJson(
        artifactPath,
        artifact,
        'Review findings follow-up materialization artifact'
    );
    if (artifactWriteViolation) {
        const rollbackViolation = rollbackTaskQueueRows(queueResult.task_path, queueResult.rollback_content);
        const rollbackNote = rollbackViolation
            || (queueResult.rollback_content === null
                ? 'No TASK.md rollback was required after follow-up artifact write failure.'
                : 'TASK.md changes were rolled back after follow-up artifact write failure.');
        const failureQueueResult: TaskQueueMaterializationResult = rollbackViolation
            ? queueResult
            : {
                ...queueResult,
                outcome: 'write_failed',
                created: [],
                blocked_fingerprints: queueResult.created.map((item) => item.fingerprint),
                error_message: artifactWriteViolation,
                rollback_content: null
            };
        return buildBlockedResult({
            repoRoot,
            taskId,
            reviewType,
            artifactPath,
            dispositionArtifactPath,
            dispositionArtifactSha256,
            dispositionResultSha256: disposition.disposition_result_sha256,
            validationArtifactPath,
            validationArtifactSha256: validationResult.artifact_sha256,
            validationResultSha256: validationArtifact.validation_result_sha256,
            validationArtifact,
            receiptPath,
            receiptSha256: receiptValidation.receiptSha256,
            items: buildMaterializationItems({
                baseItems: built.items,
                obligations: built.obligations,
                queueResult: failureQueueResult
            }),
            violations: [
                artifactWriteViolation,
                rollbackNote
            ]
        });
    }

    const marker = status === 'MATERIALIZED'
        ? 'REVIEW_FINDINGS_FOLLOW_UP_TASKS_MATERIALIZED'
        : (status === 'ALREADY_MATERIALIZED'
            ? 'REVIEW_FINDINGS_FOLLOW_UP_TASKS_ALREADY_MATERIALIZED'
            : (status === 'BLOCKED'
                ? 'REVIEW_FINDINGS_FOLLOW_UP_TASKS_BLOCKED'
                : 'REVIEW_FINDINGS_FOLLOW_UP_TASKS_NOT_REQUIRED'));
    return {
        status,
        task_id: taskId,
        review_type: reviewType,
        artifact_path: normalizePath(artifactPath),
        created_task_ids: [...new Set(queueResult.created.map((item) => item.task_id))],
        reused_task_ids: [...new Set(queueResult.reused.map((item) => item.task_id))],
        violations: [],
        output_lines: [
            ...formatOutput({
            repoRoot,
            taskId,
            status,
            marker,
            action: status === 'BLOCKED'
                ? 'Resolve review findings marked fix_now, then rerun review validation.'
                : (status === 'NOT_REQUIRED'
                    ? 'Continue through the navigator; no deferred review findings required follow-up tasks.'
                    : 'Continue through the navigator with review follow-up tasks linked in TASK.md.'),
            reason: status === 'MATERIALIZED'
                ? `${queueResult.created.length} follow-up task(s) created.`
                : (status === 'ALREADY_MATERIALIZED'
                    ? `${queueResult.reused.length} follow-up task(s) already linked.`
                    : (status === 'BLOCKED'
                        ? 'Disposition artifact contains review findings that require fix_now remediation.'
                        : 'Disposition artifact contained no create_follow_up obligations.')),
            artifactPath,
            violations: []
            }),
            `FollowUpTaskProfile: ${materializationContext.task_profile || '<unavailable>'} ` +
            `(source=${materializationContext.task_profile_source}, ` +
            `parent=${materializationContext.parent_profile || '<unavailable>'})`,
            ...materializationContext.diagnostics.map((diagnostic) => `FollowUpTaskProfileDiagnostic: ${diagnostic}`)
        ]
    };
}
