import { createHash } from 'node:crypto';
import * as path from 'node:path';

import { sha256RedactedJsonPayload } from '../../core/redaction';
import { readReviewArtifactFileSha256 } from '../../gate-runtime/review-artifacts';
import type { ReviewFindingDispositionAction } from '../../policy/profile-resolver';
import type { TaskQueueEntry } from '../../core/task-queue-read';
import type { ReviewReuseTelemetryEventLike } from '../review-reuse/review-reuse-telemetry';
import {
    resolveLockedReviewFindingPolicyFromPreflight,
    resolveLockedReviewFindingPolicyFromReceiptDispositionEvidence
} from '../review/review-finding-disposition';
import { validateReviewFindingsDispositionEvidence } from '../review/review-findings-disposition-evidence';
import type { ReviewFindingsDispositionArtifactItem } from '../review/review-findings-disposition-artifact';
import type { ReviewFindingsSeverity } from '../review/review-findings-schema';
import {
    buildReviewOutputCorrectionHandoff,
    computeReviewOutputCorrectionProviderCapabilitiesSha256,
    getReviewOutputCorrectionArtifactPath,
    isProviderOwnedReviewOutputCorrectionSessionAttestationSource,
    readReviewOutputCorrectionArtifact,
    resolveReviewOutputCorrectionTransport,
    requiresReviewOutputCorrectionFailClosedAvailabilityEvidence,
    REVIEW_OUTPUT_CORRECTION_FAIL_CLOSED_ATTESTATION_SOURCE,
    type ReviewOutputCorrectionArtifact
} from '../review/review-output-correction';
import {
    validateReviewFindingsValidationArtifactForReceipt,
    type NormalizedReviewFindingInventoryEntry,
    type NormalizedReviewResidualRiskInventoryEntry
} from '../review/review-findings-validation-artifact';
import { normalizePath } from '../shared/helpers';
import type { ReviewAttemptSummary } from './task-audit-summary-review-attempts';
import type { FinalCloseoutReviewIntegrityAttestation } from './task-audit-summary-review-integrity';
import type { TaskCycleBindingSnapshot } from '../task-events-summary/task-events-summary-cycle-binding';
import {
    collectKnownRequiredReviewTypes,
    isPlainRecord,
    safeReadJson
} from './task-audit-summary-review-common';

const REVIEW_FINDING_SEVERITIES = ['critical', 'high', 'medium', 'low'] as const satisfies readonly ReviewFindingsSeverity[];

export interface ReviewFindingsAuditItem {
    id: string;
    kind: 'finding' | 'residual_risk';
    severity: ReviewFindingsSeverity | 'residual_risk';
    title: string | null;
    description: string;
    evidence_locations: string[];
    coverage_obligation_ids: string[];
    action: ReviewFindingDispositionAction | null;
    source_rule?: string | null;
    materialization_status: string | null;
    follow_up_task_id: string | null;
    blocking: boolean;
}

export interface ReviewFindingsAuditLane {
    review_type: string;
    source_mode: 'fresh' | 'reused';
    validation_status: 'ACCEPTED' | 'REJECTED' | 'MISSING_OR_INVALID';
    validation_violations: string[];
    disposition_status: 'SATISFIED' | 'BLOCKED' | 'NOT_AVAILABLE';
    disposition_counts: {
        fix_now: number;
        create_follow_up: number;
        ignore: number;
    };
    disposition_violations: string[];
    findings: ReviewFindingsAuditItem[];
    remaining_blocker_ids: string[];
}

export interface ReviewFindingsValidationFailureAudit {
    timestamp_utc: string | null;
    review_type: string;
    reviewer_identity: string | null;
    violation: string;
    validation_artifact_sha256: string | null;
}

export interface ReviewFindingsRemediationCycleAudit {
    timestamp_utc: string | null;
    reason: string | null;
    invalidated_review_types: string[];
    preserved_review_types: string[];
    launch_required_review_types: string[];
    reused_review_types: string[];
}

export interface ReviewOutputCorrectionTransportAudit {
    task_id?: string | null;
    task_sequence?: number | null;
    event_sha256?: string | null;
    audit_scope?: 'CURRENT' | 'SUPERSEDED_CYCLE';
    superseded_by_compile_event_sha256?: string | null;
    timestamp_utc: string | null;
    event_type: string;
    review_type: string;
    transport:
        | 'validation_rejection'
        | 'live_reviewer_continuation'
        | 'api_conversation_continuation'
        | 'correction_only_invocation'
        | 'full_reviewer_relaunch'
        | 'invocation_attestation'
        | 'acceptance';
    session_availability: string | null;
    correction_attempt: number | null;
    correction_package_sha256: string | null;
    reviewer_invocation_event_sha256: string | null;
    provider_capabilities_sha256: string | null;
    evidence_valid: boolean;
    violations: string[];
}

function correctionAuditEventBinding(event: ReviewReuseTelemetryEventLike): {
    task_id: string | null;
    task_sequence: number | null;
    event_sha256: string | null;
} {
    const details = isPlainRecord(event.details) ? event.details : {};
    const integrity = isPlainRecord(event.integrity) ? event.integrity : {};
    return {
        task_id: stringValue(details.task_id),
        task_sequence: typeof integrity.task_sequence === 'number'
            && Number.isInteger(integrity.task_sequence) && integrity.task_sequence > 0
            ? integrity.task_sequence : null,
        event_sha256: stringValue(integrity.event_sha256)
    };
}

function scopeCorrectionTransports(options: {
    taskId: string;
    transports: ReviewOutputCorrectionTransportAudit[];
    timelineEvents: readonly ReviewReuseTelemetryEventLike[];
    currentCycle?: TaskCycleBindingSnapshot | null;
    reviewIntegrityAttestation?: FinalCloseoutReviewIntegrityAttestation | null;
    timelineIntegrityStatus?: string;
    currentPreflightSha256?: string | null;
    requiredReviewTypes: readonly string[];
}): ReviewOutputCorrectionTransportAudit[] {
    const attestation = options.reviewIntegrityAttestation;
    const trustedCurrentReviews = attestation?.status === 'INDEPENDENT_REVIEW_ATTESTED'
        && attestation.completion_review_attested && attestation.completion_allowed
        && attestation.observed_issues.length === 0
        && options.timelineIntegrityStatus === 'PASS'
        && isSha256(options.currentPreflightSha256 || null)
        && options.currentCycle?.preflight_sha256 === options.currentPreflightSha256;
    const compileEvents = trustedCurrentReviews && options.currentCycle?.compile_gate_timestamp
        ? options.timelineEvents.filter((event) => isPlainRecord(event)
            && event.event_type === 'COMPILE_GATE_PASSED'
            && event.timestamp_utc === options.currentCycle?.compile_gate_timestamp
            && (event.task_id === options.taskId
                || (isPlainRecord(event.details) && event.details.task_id === options.taskId)))
        : [];
    const compile = compileEvents.length === 1 ? compileEvents[0] : null;
    const compileIntegrity = isPlainRecord(compile?.integrity) ? compile.integrity : {};
    const compileSequence = compileIntegrity.task_sequence;
    const compileSha256 = stringValue(compileIntegrity.event_sha256);
    const hasBoundCompile = typeof compileSequence === 'number'
        && Number.isInteger(compileSequence) && compileSequence > 0 && isSha256(compileSha256);
    const eventHashCounts = new Map<string, number>();
    for (const event of options.timelineEvents) {
        const integrity = isPlainRecord(event.integrity) ? event.integrity : {};
        const hash = stringValue(integrity.event_sha256);
        if (hash) eventHashCounts.set(hash, (eventHashCounts.get(hash) || 0) + 1);
    }
    return options.transports.map((entry) => {
        const superseded = hasBoundCompile && eventHashCounts.get(compileSha256 || '') === 1
            && entry.task_id === options.taskId && typeof entry.task_sequence === 'number'
            && entry.task_sequence < compileSequence
            && isSha256(entry.event_sha256 || null) && eventHashCounts.get(entry.event_sha256 || '') === 1
            && attestation?.required_review_types.includes(entry.review_type)
            && options.requiredReviewTypes.includes(entry.review_type);
        return {
            ...entry,
            audit_scope: superseded ? 'SUPERSEDED_CYCLE' : 'CURRENT',
            superseded_by_compile_event_sha256: superseded ? compileSha256 : null
        };
    });
}

export interface ReviewFindingsAuditSummary {
    status: 'CLEAR' | 'BLOCKED' | 'INCOMPLETE';
    lanes: ReviewFindingsAuditLane[];
    finding_count: number;
    residual_risk_count: number;
    disposition_counts: {
        fix_now: number;
        create_follow_up: number;
        ignore: number;
    };
    remaining_blocker_count: number;
    validation_failures: ReviewFindingsValidationFailureAudit[];
    remediation_cycles: ReviewFindingsRemediationCycleAudit[];
    correction_transports?: ReviewOutputCorrectionTransportAudit[];
    superseded_invalid_transport_count?: number;
    fresh_review_count: number;
    reused_review_count: number;
    review_follow_up_task_closure_policy?: {
        source: 'preflight_profile_policy_snapshot' | 'legacy_default';
        eligible: boolean;
        configured: boolean;
        valid: boolean;
        provenance: string | null;
        source_notes_sha256: string | null;
        skip_low_findings: boolean;
        forbid_child_tasks: boolean;
        ignored_low_findings_count: number;
        retained_current_task_count: number;
        prohibited_descendant_creation_count: number;
        remaining_blocker_count: number;
        diagnostics: string[];
        visible_summary_line: string;
    } | null;
    visible_summary_line: string;
}

function stringValue(value: unknown): string | null {
    const normalized = String(value || '').trim();
    return normalized || null;
}

function stringArray(value: unknown): string[] {
    return Array.isArray(value)
        ? value.map((entry) => String(entry || '').trim()).filter(Boolean)
        : [];
}

function uniqueStrings(values: readonly string[]): string[] {
    return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function readOutputContractString(receipt: Record<string, unknown>, key: string): string | null {
    const contract = isPlainRecord(receipt.review_output_contract) ? receipt.review_output_contract : null;
    return stringValue(contract?.[key]);
}

function readCoverageContractSha256(receipt: Record<string, unknown>): string | null {
    const coverage = isPlainRecord(receipt.review_coverage) ? receipt.review_coverage : null;
    return readOutputContractString(receipt, 'coverage_contract_sha256')
        || stringValue(coverage?.contract_sha256);
}

function followUpTaskIdsByFinding(followUpArtifactPath: string | null, evidenceValid: boolean): Map<string, string> {
    if (!evidenceValid || !followUpArtifactPath) {
        return new Map();
    }
    const artifact = safeReadJson(followUpArtifactPath);
    const items = Array.isArray(artifact?.items) ? artifact.items : [];
    return new Map(items
        .filter((item): item is Record<string, unknown> => isPlainRecord(item))
        .map((item) => [stringValue(item.source_item_id), stringValue(item.task_id)] as const)
        .filter((entry): entry is [string, string] => !!entry[0] && !!entry[1]));
}

function buildFindingItem(
    finding: NormalizedReviewFindingInventoryEntry,
    disposition: ReviewFindingsDispositionArtifactItem | undefined,
    followUpTaskId: string | null
): ReviewFindingsAuditItem {
    return {
        id: finding.id,
        kind: 'finding',
        severity: finding.severity,
        title: finding.title,
        description: finding.description,
        evidence_locations: [...finding.evidence_locations],
        coverage_obligation_ids: [...finding.coverage_obligation_ids],
        action: disposition?.action ?? null,
        source_rule: disposition?.source_rule ?? null,
        materialization_status: followUpTaskId
            ? 'MATERIALIZED'
            : disposition?.materialization_status ?? null,
        follow_up_task_id: followUpTaskId,
        blocking: disposition?.blocking === true
    };
}

function buildResidualRiskItem(
    risk: NormalizedReviewResidualRiskInventoryEntry,
    disposition: ReviewFindingsDispositionArtifactItem | undefined,
    followUpTaskId: string | null
): ReviewFindingsAuditItem {
    return {
        id: risk.id,
        kind: 'residual_risk',
        severity: 'residual_risk',
        title: null,
        description: risk.description,
        evidence_locations: [...risk.evidence_locations],
        coverage_obligation_ids: [],
        action: disposition?.action ?? null,
        source_rule: disposition?.source_rule ?? null,
        materialization_status: followUpTaskId
            ? 'MATERIALIZED'
            : disposition?.materialization_status ?? null,
        follow_up_task_id: followUpTaskId,
        blocking: disposition?.blocking === true
    };
}

function buildMissingLane(reviewType: string, reason: string): ReviewFindingsAuditLane {
    return {
        review_type: reviewType,
        source_mode: 'fresh',
        validation_status: 'MISSING_OR_INVALID',
        validation_violations: [reason],
        disposition_status: 'NOT_AVAILABLE',
        disposition_counts: { fix_now: 0, create_follow_up: 0, ignore: 0 },
        disposition_violations: [],
        findings: [],
        remaining_blocker_ids: []
    };
}

function buildCurrentFindingsLane(options: {
    repoRoot: string;
    reviewsRoot: string;
    taskId: string;
    reviewType: string;
    currentPreflight: Record<string, unknown> | null;
    taskQueueEntries?: ReadonlyMap<string, TaskQueueEntry>;
}): ReviewFindingsAuditLane | null {
    const receiptPath = path.join(options.reviewsRoot, `${options.taskId}-${options.reviewType}-receipt.json`);
    const receipt = safeReadJson(receiptPath);
    if (!receipt) {
        return buildMissingLane(options.reviewType, `Structured review receipt is missing: ${normalizePath(receiptPath)}.`);
    }
    if (stringValue(receipt.review_output_format) !== 'findings_json') {
        return null;
    }

    const reviewArtifactPath = path.join(options.reviewsRoot, `${options.taskId}-${options.reviewType}.md`);
    const reviewContextPath = path.join(options.reviewsRoot, `${options.taskId}-${options.reviewType}-review-context.json`);
    const preflightPath = path.join(options.reviewsRoot, `${options.taskId}-preflight.json`);
    const reused = receipt.reused_existing_review === true;
    const validation = validateReviewFindingsValidationArtifactForReceipt({
        receipt,
        reviewArtifactPath,
        expectedTaskId: options.taskId,
        expectedReviewType: options.reviewType,
        expectedReviewOutputSha256: stringValue(receipt.review_output_sha256),
        expectedReviewArtifactSha256: stringValue(receipt.review_artifact_sha256),
        expectedReviewContextPath: reused ? null : reviewContextPath,
        expectedReviewContextSha256: reused
            ? stringValue(receipt.reused_from_review_context_sha256)
            : stringValue(receipt.review_context_sha256),
        expectedPreflightPath: reused ? null : preflightPath,
        expectedPreflightSha256: reused ? null : stringValue(receipt.preflight_sha256),
        expectedScopeSha256: reused ? null : stringValue(receipt.scope_sha256),
        expectedReviewScopeSha256: reused
            ? stringValue(receipt.reused_from_review_scope_sha256)
            : stringValue(receipt.review_scope_sha256),
        expectedCodeScopeSha256: reused
            ? stringValue(receipt.reused_from_code_scope_sha256)
            : stringValue(receipt.code_scope_sha256),
        expectedReviewTreeStateSha256: reused
            ? stringValue(receipt.reused_from_review_tree_state_sha256)
            : stringValue(receipt.review_tree_state_sha256),
        expectedCoverageContractSha256: readCoverageContractSha256(receipt),
        requireAccepted: true,
        preferSnapshot: reused
    });
    const validationViolations = uniqueStrings([
        ...validation.violations,
        ...(validation.artifact?.validation_result.violations || [])
    ]);
    if (!validation.artifact || !validation.reference || !validation.artifact_sha256) {
        return {
            ...buildMissingLane(options.reviewType, validationViolations[0] || 'Structured findings validation evidence is unavailable.'),
            source_mode: reused ? 'reused' : 'fresh',
            validation_violations: validationViolations
        };
    }

    const policyResolution = reused
        ? resolveLockedReviewFindingPolicyFromReceiptDispositionEvidence(receipt)
        : resolveLockedReviewFindingPolicyFromPreflight(options.currentPreflight);
    const disposition = validation.valid && validation.accepted
        ? validateReviewFindingsDispositionEvidence({
            repoRoot: options.repoRoot,
            receipt,
            receiptPath,
            reviewArtifactPath,
            expectedTaskId: options.taskId,
            expectedReviewType: options.reviewType,
            validationArtifact: validation.artifact,
            validationArtifactPath: validation.reference.artifact_path,
            validationArtifactSha256: validation.artifact_sha256,
            policyResolution,
            expectedReceiptPath: reused ? stringValue(receipt.reused_from_receipt_path) : null,
            expectedReceiptSha256: reused ? stringValue(receipt.reused_from_receipt_sha256) : null,
            preferSnapshot: reused,
            taskQueueRows: options.taskQueueEntries
                ? [...options.taskQueueEntries.values()]
                : undefined
        })
        : null;
    const dispositionItems = new Map((disposition?.artifact?.items || []).map((item) => [item.id, item]));
    const followUpTaskIds = followUpTaskIdsByFinding(
        disposition?.follow_up_artifact_path || null,
        disposition?.valid === true
    );
    const inventory = validation.artifact.validation_result.normalized_inventory;
    const findings: ReviewFindingsAuditItem[] = [];
    for (const severity of REVIEW_FINDING_SEVERITIES) {
        for (const finding of inventory.findings_by_severity[severity]) {
            findings.push(buildFindingItem(
                finding,
                dispositionItems.get(finding.id),
                followUpTaskIds.get(finding.id) || null
            ));
        }
    }
    for (const risk of inventory.residual_risks) {
        findings.push(buildResidualRiskItem(
            risk,
            dispositionItems.get(risk.id),
            followUpTaskIds.get(risk.id) || null
        ));
    }
    const dispositionCounts = disposition?.artifact?.disposition_result.counts_by_action || {
        fix_now: 0,
        create_follow_up: 0,
        ignore: 0
    };
    const dispositionViolations = uniqueStrings(disposition?.violations || []);
    const remainingBlockerIds = uniqueStrings([
        ...(disposition?.artifact?.disposition_result.blocking_ids || []),
        ...findings
            .filter((item) => item.action === 'create_follow_up' && !item.follow_up_task_id)
            .map((item) => item.id)
    ]);

    return {
        review_type: options.reviewType,
        source_mode: reused ? 'reused' : 'fresh',
        validation_status: validation.accepted
            ? validation.valid ? 'ACCEPTED' : 'MISSING_OR_INVALID'
            : 'REJECTED',
        validation_violations: validationViolations,
        disposition_status: !disposition
            ? 'NOT_AVAILABLE'
            : disposition.valid ? 'SATISFIED' : 'BLOCKED',
        disposition_counts: { ...dispositionCounts },
        disposition_violations: dispositionViolations,
        findings,
        remaining_blocker_ids: remainingBlockerIds
    };
}

function collectValidationFailures(events: readonly ReviewReuseTelemetryEventLike[]): ReviewFindingsValidationFailureAudit[] {
    return events.flatMap((event) => {
        if (String(event.event_type || '').trim().toUpperCase() !== 'REVIEWER_LAUNCH_FAILED') {
            return [];
        }
        const details = isPlainRecord(event.details) ? event.details : {};
        const eventRecord = event as unknown as Record<string, unknown>;
        if (stringValue(details.launch_failure_stage) !== 'review_findings_validation') {
            return [];
        }
        return [{
            timestamp_utc: stringValue(eventRecord.timestamp_utc),
            review_type: stringValue(details.review_type) || 'unknown',
            reviewer_identity: stringValue(details.reviewer_identity),
            violation: stringValue(details.launch_failure_reason) || 'Structured findings validation rejected the reviewer output.',
            validation_artifact_sha256: stringValue(details.review_findings_validation_artifact_sha256)
        }];
    });
}

function collectRemediationCycles(events: readonly ReviewReuseTelemetryEventLike[]): ReviewFindingsRemediationCycleAudit[] {
    return events.flatMap((event) => {
        if (String(event.event_type || '').trim().toUpperCase() !== 'REVIEW_CYCLE_RESTARTED') {
            return [];
        }
        const details = isPlainRecord(event.details) ? event.details : {};
        const eventRecord = event as unknown as Record<string, unknown>;
        return [{
            timestamp_utc: stringValue(eventRecord.timestamp_utc),
            reason: stringValue(details.restart_reason),
            invalidated_review_types: stringArray(details.invalidated_review_types),
            preserved_review_types: stringArray(details.preserved_review_types),
            launch_required_review_types: stringArray(details.launch_required_review_types),
            reused_review_types: stringArray(details.reused_review_types)
        }];
    });
}

function isSha256(value: string | null): value is string {
    return !!value && /^[0-9a-f]{64}$/u.test(value);
}

function isCanonicalCorrectionReviewType(value: string | null): value is string {
    return !!value && /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(value);
}

interface IndexedCorrectionEvent {
    eventIndex: number;
    timestampUtc: string | null;
    details: Record<string, unknown>;
}

type CorrectionTransportSelection = Exclude<
    ReviewOutputCorrectionTransportAudit['transport'],
    'invocation_attestation' | 'acceptance'
>;

type CorrectionContinuationTransport = Exclude<
    CorrectionTransportSelection,
    'validation_rejection'
>;

interface IndexedCorrectionTransportEvent extends IndexedCorrectionEvent {
    eventType: string;
    transport: CorrectionTransportSelection;
}

interface CorrectionTransportEventCollection {
    transportEvents: readonly IndexedCorrectionTransportEvent[];
    acceptedCorrectionResponses: readonly IndexedCorrectionEvent[];
    correctionInvocationAttestations: readonly IndexedCorrectionEvent[];
    evidenceWindowsBySelectionIndex: ReadonlyMap<number, CorrectionTransportEvidenceWindow>;
    reviewerInvocationsBySha256: ReadonlyMap<string, readonly IndexedCorrectionEvent[]>;
    selectionsByPreviousPackage: ReadonlyMap<string, readonly IndexedCorrectionEvent[]>;
    selectionEventsByIndex: ReadonlyMap<number, IndexedCorrectionTransportEvent>;
    nextSelectionIndexByEventIndex: ReadonlyMap<number, number>;
}

interface CorrectionTransportEvidenceWindow {
    acceptedResponses: IndexedCorrectionEvent[];
    invocationAttestations: IndexedCorrectionEvent[];
    retryRejections: IndexedCorrectionEvent[];
}

interface CorrectionTransportWorkMetrics {
    timeline_events_indexed: number;
    evidence_events_windowed: number;
    evidence_candidates_examined: number;
    selection_candidates_examined: number;
    artifact_reads: number;
    artifact_read_cache_hits: number;
    artifact_hash_reads: number;
    artifact_hash_cache_hits: number;
}

const CORRECTION_TRANSPORT_BY_EVENT_TYPE = new Map<string, CorrectionTransportSelection>([
    ['REVIEW_OUTPUT_CORRECTION_REQUIRED', 'validation_rejection'],
    ['REVIEW_OUTPUT_CORRECTION_LIVE_CONTINUATION', 'live_reviewer_continuation'],
    ['REVIEW_OUTPUT_CORRECTION_API_CONTINUATION', 'api_conversation_continuation'],
    ['REVIEW_OUTPUT_CORRECTION_ONLY_INVOCATION', 'correction_only_invocation'],
    ['REVIEW_OUTPUT_CORRECTION_FULL_REVIEW_REQUIRED', 'full_reviewer_relaunch']
]);

const CORRECTION_SELECTION_EVENT_TYPES = new Set([
    'REVIEW_OUTPUT_CORRECTION_LIVE_CONTINUATION',
    'REVIEW_OUTPUT_CORRECTION_API_CONTINUATION',
    'REVIEW_OUTPUT_CORRECTION_ONLY_INVOCATION',
    'REVIEW_OUTPUT_CORRECTION_FULL_REVIEW_REQUIRED'
]);

interface CorrectionArtifactCacheEntry {
    fileSha256?: string | null;
    artifactRead?: ReturnType<typeof readReviewOutputCorrectionArtifact>;
}

interface CorrectionArtifactCache {
    entries: Map<string, CorrectionArtifactCacheEntry>;
    workMetrics: CorrectionTransportWorkMetrics;
}

function appendCorrectionEvent(
    index: Map<string, IndexedCorrectionEvent[]>,
    reviewType: string | null,
    event: IndexedCorrectionEvent
): void {
    if (!reviewType) {
        return;
    }
    const indexedEvents = index.get(reviewType);
    if (indexedEvents) {
        indexedEvents.push(event);
        return;
    }
    index.set(reviewType, [event]);
}

function filterCorrectionEvents(
    events: readonly IndexedCorrectionEvent[],
    workMetrics: CorrectionTransportWorkMetrics,
    predicate: (event: IndexedCorrectionEvent) => boolean
): IndexedCorrectionEvent[] {
    const matches: IndexedCorrectionEvent[] = [];
    for (const event of events) {
        workMetrics.evidence_candidates_examined += 1;
        if (predicate(event)) {
            matches.push(event);
        }
    }
    return matches;
}

function findCorrectionEvent(
    events: readonly IndexedCorrectionEvent[],
    workMetrics: CorrectionTransportWorkMetrics,
    predicate: (event: IndexedCorrectionEvent) => boolean
): IndexedCorrectionEvent | undefined {
    for (const event of events) {
        workMetrics.evidence_candidates_examined += 1;
        if (predicate(event)) {
            return event;
        }
    }
    return undefined;
}

function hasCorrectionSelection(
    events: readonly IndexedCorrectionEvent[],
    workMetrics: CorrectionTransportWorkMetrics,
    predicate: (event: IndexedCorrectionEvent) => boolean
): boolean {
    for (const event of events) {
        workMetrics.selection_candidates_examined += 1;
        if (predicate(event)) {
            return true;
        }
    }
    return false;
}

function collectCorrectionTransportEvents(
    events: readonly ReviewReuseTelemetryEventLike[],
    options: {
        taskId: string;
        authorizedReviewTypes: ReadonlySet<string>;
        workMetrics: CorrectionTransportWorkMetrics;
    }
): CorrectionTransportEventCollection {
    const transportEvents: IndexedCorrectionTransportEvent[] = [];
    const acceptedCorrectionResponses: IndexedCorrectionEvent[] = [];
    const correctionInvocationAttestations: IndexedCorrectionEvent[] = [];
    const evidenceWindowsBySelectionIndex = new Map<number, CorrectionTransportEvidenceWindow>();
    const reviewerInvocationsBySha256 = new Map<string, IndexedCorrectionEvent[]>();
    const selectionsByPreviousPackage = new Map<string, IndexedCorrectionEvent[]>();
    const selectionEventsByIndex = new Map<number, IndexedCorrectionTransportEvent>();
    const nextSelectionIndexByEventIndex = new Map<number, number>();
    const latestSelectionIndexByReviewType = new Map<string, number>();

    for (const [eventIndex, event] of events.entries()) {
        options.workMetrics.timeline_events_indexed += 1;
        const eventType = String(event.event_type || '').trim().toUpperCase();
        const details = isPlainRecord(event.details) ? event.details : {};
        const eventRecord = event as unknown as Record<string, unknown>;
        const indexedEvent: IndexedCorrectionEvent = {
            eventIndex,
            timestampUtc: stringValue(eventRecord.timestamp_utc),
            details
        };
        const transport = CORRECTION_TRANSPORT_BY_EVENT_TYPE.get(eventType);
        if (transport) {
            transportEvents.push({ ...indexedEvent, eventType, transport });
        }
        const indexedReviewTypeValue = stringValue(details.review_type);
        const indexedReviewType = isCanonicalCorrectionReviewType(indexedReviewTypeValue)
            && options.authorizedReviewTypes.has(indexedReviewTypeValue)
            ? indexedReviewTypeValue
            : null;
        const integrity = isPlainRecord(event.integrity) ? event.integrity : {};
        const reviewerInvocationEventSha256 = stringValue(integrity.event_sha256);
        const activeSelectionIndex = indexedReviewType
            ? latestSelectionIndexByReviewType.get(indexedReviewType)
            : undefined;
        const activeEvidenceWindow = activeSelectionIndex === undefined
            ? undefined
            : evidenceWindowsBySelectionIndex.get(activeSelectionIndex);
        if (
            eventType === 'REVIEWER_INVOCATION_ATTESTED'
            && isSha256(reviewerInvocationEventSha256)
        ) {
            appendCorrectionEvent(
                reviewerInvocationsBySha256,
                reviewerInvocationEventSha256,
                indexedEvent
            );
        } else if (eventType === 'REVIEW_OUTPUT_CORRECTION_ACCEPTED') {
            acceptedCorrectionResponses.push(indexedEvent);
            if (activeEvidenceWindow) {
                activeEvidenceWindow.acceptedResponses.push(indexedEvent);
                options.workMetrics.evidence_events_windowed += 1;
            }
        } else if (eventType === 'REVIEW_OUTPUT_CORRECTION_INVOCATION_ATTESTED') {
            correctionInvocationAttestations.push(indexedEvent);
            if (activeEvidenceWindow) {
                activeEvidenceWindow.invocationAttestations.push(indexedEvent);
                options.workMetrics.evidence_events_windowed += 1;
            }
        } else if (eventType === 'REVIEW_OUTPUT_CORRECTION_REQUIRED') {
            if (activeEvidenceWindow) {
                activeEvidenceWindow.retryRejections.push(indexedEvent);
                options.workMetrics.evidence_events_windowed += 1;
            }
        }
        if (
            !CORRECTION_SELECTION_EVENT_TYPES.has(eventType)
            || stringValue(details.task_id) !== options.taskId
            || !indexedReviewType
            || !transport
        ) {
            continue;
        }
        const selectionEvent = { ...indexedEvent, eventType, transport };
        selectionEventsByIndex.set(eventIndex, selectionEvent);
        evidenceWindowsBySelectionIndex.set(eventIndex, {
            acceptedResponses: [],
            invocationAttestations: [],
            retryRejections: []
        });
        const previousPackageSha256 = stringValue(details.previous_correction_package_sha256);
        if (isSha256(previousPackageSha256)) {
            appendCorrectionEvent(
                selectionsByPreviousPackage,
                previousPackageSha256,
                indexedEvent
            );
        }
        const previousSelectionIndex = latestSelectionIndexByReviewType.get(indexedReviewType);
        if (previousSelectionIndex !== undefined) {
            nextSelectionIndexByEventIndex.set(previousSelectionIndex, eventIndex);
        }
        latestSelectionIndexByReviewType.set(indexedReviewType, eventIndex);
    }

    return {
        transportEvents,
        acceptedCorrectionResponses,
        correctionInvocationAttestations,
        evidenceWindowsBySelectionIndex,
        reviewerInvocationsBySha256,
        selectionsByPreviousPackage,
        selectionEventsByIndex,
        nextSelectionIndexByEventIndex
    };
}

function hasTrustedOriginalReviewerInvocation(options: {
    reviewerInvocationsBySha256: ReadonlyMap<string, readonly IndexedCorrectionEvent[]>;
    eventIndex: number;
    taskId: string;
    reviewType: string;
    reviewerIdentity: string | null;
    reviewerAttemptId: string | null;
    providerId: string | null;
    providerInvocationId: string | null;
    reviewerInvocationEventSha256: string | null;
}): boolean {
    if (
        !options.reviewerIdentity
        || !options.reviewerAttemptId
        || !options.providerId
        || !options.providerInvocationId
        || !isSha256(options.reviewerInvocationEventSha256)
    ) {
        return false;
    }
    const candidates = options.reviewerInvocationsBySha256.get(
        options.reviewerInvocationEventSha256
    ) || [];
    if (candidates.length !== 1) {
        return false;
    }
    const candidate = candidates[0];
    const details = candidate.details;
    const originalProviderId = stringValue(
        details.execution_provider
        ?? details.provider
        ?? details.provider_family
        ?? details.reviewer_launch_tool
        ?? details.launch_tool
    );
    const originalAttemptId = Object.prototype.hasOwnProperty.call(details, 'reviewer_launch_attempt_id')
        ? stringValue(details.reviewer_launch_attempt_id)
        : stringValue(details.provider_invocation_id);
    return candidate.eventIndex < options.eventIndex
        && stringValue(details.task_id) === options.taskId
        && stringValue(details.review_type) === options.reviewType
        && stringValue(details.reviewer_execution_mode) === 'delegated_subagent'
        && stringValue(details.reviewer_identity) === options.reviewerIdentity
        && originalAttemptId === options.reviewerAttemptId
        && originalProviderId === options.providerId
        && stringValue(details.provider_invocation_id) === options.providerInvocationId
        && isSha256(stringValue(details.reviewer_launch_artifact_sha256))
        && isProviderOwnedReviewOutputCorrectionSessionAttestationSource(
            stringValue(details.reviewer_launch_attestation_source) || ''
        );
}

function readCachedCorrectionArtifact(
    artifactPath: string,
    cache: CorrectionArtifactCache
): ReturnType<typeof readReviewOutputCorrectionArtifact> {
    const cached = cache.entries.get(artifactPath) || {};
    if (!cached.artifactRead) {
        cache.workMetrics.artifact_reads += 1;
        cached.artifactRead = readReviewOutputCorrectionArtifact(artifactPath);
        cache.entries.set(artifactPath, cached);
    } else {
        cache.workMetrics.artifact_read_cache_hits += 1;
    }
    return cached.artifactRead;
}

function readCachedCorrectionArtifactSha256(
    artifactPath: string,
    cache: CorrectionArtifactCache
): string | null {
    const cached = cache.entries.get(artifactPath) || {};
    if (cached.fileSha256 === undefined) {
        cache.workMetrics.artifact_hash_reads += 1;
        cached.fileSha256 = readReviewArtifactFileSha256(artifactPath);
        cache.entries.set(artifactPath, cached);
    } else {
        cache.workMetrics.artifact_hash_cache_hits += 1;
    }
    return cached.fileSha256;
}

function correctionSelectionMatchesValidationRejection(options: {
    selection: IndexedCorrectionEvent;
    rejectionEventIndex: number;
    taskId: string;
    reviewType: string;
    correctionAttempt: number;
    reviewerIdentity: string;
    reviewerAttemptId: string;
    providerId: string | null;
    providerInvocationId: string | null;
    reviewerInvocationEventSha256: string;
}): boolean {
    const details = options.selection.details;
    return options.selection.eventIndex > options.rejectionEventIndex
        && stringValue(details.task_id) === options.taskId
        && stringValue(details.review_type) === options.reviewType
        && details.correction_attempt === options.correctionAttempt
        && stringValue(details.reviewer_identity) === options.reviewerIdentity
        && stringValue(details.reviewer_attempt_id) === options.reviewerAttemptId
        && stringValue(details.provider_id) === options.providerId
        && stringValue(details.provider_invocation_id) === options.providerInvocationId
        && stringValue(details.reviewer_invocation_event_sha256)
            === options.reviewerInvocationEventSha256;
}

function validateTerminalCorrectionRejectionArtifact(options: {
    repoRoot: string;
    reviewsRoot: string;
    taskId: string;
    reviewType: string;
    correctionAttempt: number;
    correctionPackageSha256: string;
    reviewerIdentity: string;
    reviewerAttemptId: string;
    providerId: string | null;
    providerInvocationId: string | null;
    reviewerInvocationEventSha256: string;
    details: Record<string, unknown>;
    artifactCache: CorrectionArtifactCache;
}): string[] {
    if (!isCanonicalCorrectionReviewType(options.reviewType)) {
        return [];
    }
    const violations: string[] = [];
    const expectedArtifactPath = getReviewOutputCorrectionArtifactPath(
        path.join(options.reviewsRoot, `${options.taskId}-${options.reviewType}.md`)
    );
    const eventArtifactPath = stringValue(options.details.correction_artifact_path);
    const resolvedEventArtifactPath = eventArtifactPath
        ? path.resolve(options.repoRoot, eventArtifactPath)
        : null;
    if (
        !resolvedEventArtifactPath
        || normalizePath(resolvedEventArtifactPath).toLowerCase()
            !== normalizePath(path.resolve(expectedArtifactPath)).toLowerCase()
    ) {
        return ['Correction validation rejection does not reference its canonical correction artifact.'];
    }
    const persistedRead = readCachedCorrectionArtifact(expectedArtifactPath, options.artifactCache);
    if (persistedRead.violations.length > 0 || !persistedRead.artifact) {
        return ['Correction validation rejection lacks an intact task-owned correction artifact.'];
    }
    const persisted = persistedRead.artifact;
    const binding = persisted.transport_binding;
    if (
        persisted.task_id !== options.taskId
        || persisted.review_type !== options.reviewType
        || persisted.state !== 'REVIEW_OUTPUT_CORRECTION_REQUIRED'
        || persisted.recovery.correction_attempt !== options.correctionAttempt
        || persisted.binding.reviewer_identity !== options.reviewerIdentity
        || persisted.binding.reviewer_attempt_id !== options.reviewerAttemptId
        || persisted.binding.reviewer_invocation_event_sha256
            !== options.reviewerInvocationEventSha256
        || !binding
        || binding.provider_id !== options.providerId
        || binding.provider_invocation_id !== options.providerInvocationId
        || binding.provider_capabilities_sha256
            !== stringValue(options.details.provider_capabilities_sha256)
        || binding.session_availability !== stringValue(options.details.session_availability)
    ) {
        violations.push(
            'Task-owned correction artifact does not match validation-rejection provenance.'
        );
    }
    if (
        persisted.artifact_sha256 !== stringValue(options.details.correction_artifact_sha256)
    ) {
        violations.push(
            'Task-owned correction artifact content hash does not match validation-rejection telemetry.'
        );
    }
    if (
        readCachedCorrectionArtifactSha256(expectedArtifactPath, options.artifactCache)
            !== options.correctionPackageSha256
    ) {
        violations.push(
            'Correction validation rejection package does not match its canonical task-owned correction artifact.'
        );
    }
    return violations;
}

function correctionArtifactDerivesFromPredecessorPackage(options: {
    artifact: ReviewOutputCorrectionArtifact;
    predecessorPackageSha256: string | null;
}): boolean {
    const artifact = options.artifact;
    const binding = artifact.transport_binding;
    if (
        !binding
        || !artifact.binding.findings_semantic_fingerprint
        || !isSha256(options.predecessorPackageSha256)
    ) {
        return false;
    }
    const initialRecovery = resolveReviewOutputCorrectionTransport({
        diagnostics: artifact.diagnostics,
        capabilities: {
            gate_normalization: false,
            ...binding.provider_capabilities
        },
        correctionAttempt: artifact.recovery.correction_attempt,
        maxCorrectionAttempts: artifact.recovery.max_correction_attempts,
        sessionAvailability: 'pending'
    });
    const {
        artifact_sha256: _artifactSha256,
        producer_response_attestation: _producerResponseAttestation,
        ...artifactWithoutDerivedFields
    } = artifact;
    const predecessorWithoutHash: Omit<ReviewOutputCorrectionArtifact, 'artifact_sha256'> = {
        ...artifactWithoutDerivedFields,
        state: initialRecovery.transport === 'full_reviewer_relaunch'
            ? 'FULL_REVIEW_REQUIRED'
            : 'REVIEW_OUTPUT_CORRECTION_REQUIRED',
        updated_at_utc: artifact.created_at_utc,
        transport_binding: {
            ...binding,
            session_availability: 'pending',
            availability_attestation: null
        },
        recovery: {
            correction_attempt: artifact.recovery.correction_attempt,
            max_correction_attempts: artifact.recovery.max_correction_attempts,
            selected_transport: initialRecovery.transport,
            available_transports: initialRecovery.available,
            reason: initialRecovery.reason,
            handoff: buildReviewOutputCorrectionHandoff({
                transport: initialRecovery.transport,
                reviewerIdentity: artifact.binding.reviewer_identity
            })
        }
    };
    const predecessor = {
        ...predecessorWithoutHash,
        artifact_sha256: sha256RedactedJsonPayload(predecessorWithoutHash)
    };
    const predecessorFileSha256 = createHash('sha256')
        .update(`${JSON.stringify(predecessor, null, 2)}\n`)
        .digest('hex');
    return predecessorFileSha256 === options.predecessorPackageSha256;
}

function selectionArtifactSnapshotMatches(options: {
    reviewsRoot: string;
    taskId: string;
    reviewType: string;
    transport: Exclude<ReviewOutputCorrectionTransportAudit['transport'], 'validation_rejection'>;
    correctionAttempt: number | null;
    correctionPackageSha256: string | null;
    details: Record<string, unknown>;
    artifactCache: CorrectionArtifactCache;
}): boolean {
    if (
        !isCanonicalCorrectionReviewType(options.reviewType)
        || !options.correctionAttempt
        || !isSha256(options.correctionPackageSha256)
    ) {
        return false;
    }
    const snapshotPath = path.join(
        options.reviewsRoot,
        `${options.taskId}-${options.reviewType}-output-correction-attempt-${options.correctionAttempt}`
            + `-${options.correctionPackageSha256}.json`
    );
    if (
        readCachedCorrectionArtifactSha256(snapshotPath, options.artifactCache)
        !== options.correctionPackageSha256
    ) {
        return false;
    }
    const snapshotRead = readCachedCorrectionArtifact(snapshotPath, options.artifactCache);
    const snapshot = snapshotRead.artifact;
    const binding = snapshot?.transport_binding;
    const attestation = binding?.availability_attestation;
    return snapshotRead.violations.length === 0
        && !!snapshot
        && snapshot.task_id === options.taskId
        && snapshot.review_type === options.reviewType
        && snapshot.recovery.correction_attempt === options.correctionAttempt
        && snapshot.recovery.selected_transport === options.transport
        && snapshot.artifact_sha256 === stringValue(options.details.correction_artifact_sha256)
        && snapshot.binding.reviewer_identity === stringValue(options.details.reviewer_identity)
        && snapshot.binding.reviewer_attempt_id === stringValue(options.details.reviewer_attempt_id)
        && snapshot.binding.reviewer_invocation_event_sha256
            === stringValue(options.details.reviewer_invocation_event_sha256)
        && binding?.provider_id === stringValue(options.details.provider_id)
        && binding?.provider_invocation_id === stringValue(options.details.provider_invocation_id)
        && binding?.provider_capabilities_sha256
            === stringValue(options.details.provider_capabilities_sha256)
        && binding?.session_availability === stringValue(options.details.session_availability)
        && (attestation?.attestation_source || null)
            === stringValue(options.details.availability_attestation_source)
        && (attestation?.evidence_type || null)
            === stringValue(options.details.availability_evidence_type)
        && (attestation?.provider_invocation_event_sha256 || null)
            === stringValue(options.details.availability_provider_invocation_event_sha256)
        && (attestation?.provider_response_sha256 || null)
            === stringValue(options.details.availability_provider_response_sha256);
}

interface CorrectionArtifactChainValidationOptions {
    repoRoot: string;
    reviewsRoot: string;
    taskId: string;
    reviewType: string;
    transport: CorrectionContinuationTransport;
    correctionAttempt: number | null;
    correctionPackageSha256: string | null;
    details: Record<string, unknown>;
    artifactCache: CorrectionArtifactCache;
}

interface CorrectionArtifactChainValidationResult {
    artifact: ReviewOutputCorrectionArtifact | null;
    eventArtifactPath: string | null;
    violations: string[];
}

interface CurrentCorrectionTransportValidationOptions
    extends CorrectionArtifactChainValidationOptions {
    acceptedResponses: readonly IndexedCorrectionEvent[];
    invocationAttestations: readonly IndexedCorrectionEvent[];
    selectedEventIndex: number;
    consumedAcceptedResponseIndexes: Set<number>;
    consumedInvocationAttestationIndexes: Set<number>;
}

interface HistoricalCorrectionTransportValidationOptions
    extends CurrentCorrectionTransportValidationOptions {
    retryRejections: readonly IndexedCorrectionEvent[];
    nextSelectionPreviousPackageSha256: string | null;
}

function validateHistoricalCorrectionArtifactChain(
    options: CorrectionArtifactChainValidationOptions
): CorrectionArtifactChainValidationResult {
    const violations: string[] = [];
    if (!isCanonicalCorrectionReviewType(options.reviewType)) {
        violations.push('Historical correction transport lacks a canonical review type.');
        return { artifact: null, eventArtifactPath: null, violations };
    }
    const expectedArtifactPath = getReviewOutputCorrectionArtifactPath(
        path.join(options.reviewsRoot, `${options.taskId}-${options.reviewType}.md`)
    );
    const eventArtifactPath = stringValue(options.details.correction_artifact_path);
    const resolvedEventArtifactPath = eventArtifactPath
        ? path.resolve(options.repoRoot, eventArtifactPath)
        : null;
    if (
        !resolvedEventArtifactPath
        || normalizePath(resolvedEventArtifactPath).toLowerCase()
            !== normalizePath(path.resolve(expectedArtifactPath)).toLowerCase()
    ) {
        violations.push('Historical correction transport selection does not reference its canonical artifact path.');
        return { artifact: null, eventArtifactPath, violations };
    }
    if (!isSha256(options.correctionPackageSha256)) {
        violations.push('Historical correction transport lacks a canonical content-addressed package hash.');
        return { artifact: null, eventArtifactPath, violations };
    }
    const expectedSnapshotPath = path.join(
        options.reviewsRoot,
        `${options.taskId}-${options.reviewType}-output-correction-attempt-${options.correctionAttempt}`
            + `-${options.correctionPackageSha256}.json`
    );
    const snapshotPath = stringValue(options.details.correction_artifact_snapshot_path);
    const snapshotSha256 = stringValue(options.details.correction_artifact_snapshot_sha256);
    const resolvedSnapshotPath = snapshotPath ? path.resolve(options.repoRoot, snapshotPath) : null;
    if (
        !resolvedSnapshotPath
        || normalizePath(resolvedSnapshotPath).toLowerCase()
            !== normalizePath(path.resolve(expectedSnapshotPath)).toLowerCase()
        || snapshotSha256 !== options.correctionPackageSha256
        || readCachedCorrectionArtifactSha256(expectedSnapshotPath, options.artifactCache) !== snapshotSha256
    ) {
        violations.push('Historical correction transport lacks its content-addressed artifact snapshot.');
        return { artifact: null, eventArtifactPath, violations };
    }
    const snapshotRead = readCachedCorrectionArtifact(expectedSnapshotPath, options.artifactCache);
    const snapshot = snapshotRead.artifact;
    const snapshotBinding = snapshot?.transport_binding;
    const snapshotAttestation = snapshotBinding?.availability_attestation;
    if (
        snapshotRead.violations.length > 0
        || !snapshot
        || snapshot.task_id !== options.taskId
        || snapshot.review_type !== options.reviewType
        || snapshot.recovery.correction_attempt !== options.correctionAttempt
        || snapshot.recovery.selected_transport !== options.transport
        || snapshot.artifact_sha256 !== stringValue(options.details.correction_artifact_sha256)
        || snapshot.binding.reviewer_identity !== stringValue(options.details.reviewer_identity)
        || snapshot.binding.reviewer_attempt_id !== stringValue(options.details.reviewer_attempt_id)
        || snapshot.binding.reviewer_invocation_event_sha256
            !== stringValue(options.details.reviewer_invocation_event_sha256)
        || snapshotBinding?.provider_id !== stringValue(options.details.provider_id)
        || snapshotBinding?.provider_invocation_id !== stringValue(options.details.provider_invocation_id)
        || snapshotBinding?.provider_capabilities_sha256
            !== stringValue(options.details.provider_capabilities_sha256)
        || snapshotBinding?.session_availability !== stringValue(options.details.session_availability)
        || (snapshotAttestation?.attestation_source || null)
            !== stringValue(options.details.availability_attestation_source)
        || (snapshotAttestation?.evidence_type || null)
            !== stringValue(options.details.availability_evidence_type)
        || (snapshotAttestation?.provider_invocation_event_sha256 || null)
            !== stringValue(options.details.availability_provider_invocation_event_sha256)
        || (snapshotAttestation?.provider_response_sha256 || null)
            !== stringValue(options.details.availability_provider_response_sha256)
    ) {
        violations.push('Historical correction artifact snapshot does not match transport telemetry.');
        return { artifact: null, eventArtifactPath, violations };
    }
    if (
        options.transport !== 'full_reviewer_relaunch'
        && !correctionArtifactDerivesFromPredecessorPackage({
            artifact: snapshot,
            predecessorPackageSha256: stringValue(
                options.details.previous_correction_package_sha256
            )
        })
    ) {
        violations.push(
            'Historical correction artifact is not derived from its validation-rejection predecessor package.'
        );
        return { artifact: null, eventArtifactPath, violations };
    }
    return { artifact: snapshot, eventArtifactPath, violations };
}

function validateHistoricalCorrectionTransport(
    options: HistoricalCorrectionTransportValidationOptions
): string[] {
    const artifactValidation = validateHistoricalCorrectionArtifactChain(options);
    const violations = artifactValidation.violations;
    const snapshot = artifactValidation.artifact;
    const eventArtifactPath = artifactValidation.eventArtifactPath;
    if (!snapshot || !eventArtifactPath) {
        return violations;
    }
    if (options.transport === 'full_reviewer_relaunch') {
        return violations;
    }

    const acceptedResponses = filterCorrectionEvents(
        options.acceptedResponses,
        options.artifactCache.workMetrics,
        ({ details }) => stringValue(details.task_id) === options.taskId
    );
    const invocationAttestations = filterCorrectionEvents(
        options.invocationAttestations,
        options.artifactCache.workMetrics,
        ({ details }) => stringValue(details.task_id) === options.taskId
    );
    const retryRejection = findCorrectionEvent(
        options.retryRejections,
        options.artifactCache.workMetrics,
        ({ details }) => (
            stringValue(details.task_id) === options.taskId
            && stringValue(details.review_type) === options.reviewType
            && typeof details.correction_attempt === 'number'
            && Number.isInteger(details.correction_attempt)
            && details.correction_attempt === (options.correctionAttempt || 0) + 1
            && stringValue(details.correction_package_sha256)
                === options.nextSelectionPreviousPackageSha256
            && !!stringValue(options.details.reviewer_attempt_id)
            && stringValue(details.reviewer_attempt_id)
                === stringValue(options.details.reviewer_attempt_id)
            && stringValue(details.reviewer_identity)
                === stringValue(options.details.reviewer_identity)
            && stringValue(details.reviewer_invocation_event_sha256)
                === stringValue(options.details.reviewer_invocation_event_sha256)
            && stringValue(details.provider_id) === stringValue(options.details.provider_id)
            && stringValue(details.provider_invocation_id)
                === stringValue(options.details.provider_invocation_id)
            && stringValue(details.provider_capabilities_sha256)
                === stringValue(options.details.provider_capabilities_sha256)
            && stringValue(details.correction_artifact_path) === eventArtifactPath
        )
    );
    if (acceptedResponses.length === 0 && invocationAttestations.length === 0) {
        violations.push('Historical correction transport lacks a package-bound invocation or accepted response.');
        return violations;
    }
    if (invocationAttestations.length !== 1) {
        violations.push('Historical correction transport lacks exactly one provider invocation attestation.');
        return violations;
    }
    const invocationAttestation = invocationAttestations[0];
    const invocation = invocationAttestation.details;
    const invocationMatches = (
        stringValue(invocation.task_id) === options.taskId
        && stringValue(invocation.review_type) === options.reviewType
        && stringValue(invocation.original_reviewer_identity)
            === stringValue(options.details.reviewer_identity)
        && stringValue(invocation.reviewer_attempt_id)
            === stringValue(options.details.reviewer_attempt_id)
        && stringValue(invocation.reviewer_invocation_event_sha256)
            === stringValue(options.details.reviewer_invocation_event_sha256)
        && !!stringValue(invocation.correction_producer_identity)
        && stringValue(invocation.provider_invocation_id)
            === stringValue(options.details.provider_invocation_id)
        && isProviderOwnedReviewOutputCorrectionSessionAttestationSource(
            stringValue(invocation.attestation_source) || ''
        )
        && isSha256(stringValue(invocation.corrected_output_sha256))
        && isSha256(stringValue(invocation.provider_response_event_sha256))
        && stringValue(invocation.selected_transport) === options.transport
        && stringValue(invocation.correction_package_sha256) === options.correctionPackageSha256
        && stringValue(invocation.provider_id) === stringValue(options.details.provider_id)
        && stringValue(invocation.provider_capabilities_sha256)
            === stringValue(options.details.provider_capabilities_sha256)
        && stringValue(invocation.session_availability)
            === stringValue(options.details.session_availability)
        && typeof invocation.correction_attempt === 'number'
        && invocation.correction_attempt === options.correctionAttempt
    );
    if (!invocationMatches) {
        violations.push('Historical correction transport is not bound to its provider invocation attestation.');
        return violations;
    }
    if (acceptedResponses.length === 0) {
        if (
            !retryRejection
            || retryRejection.eventIndex <= invocationAttestation.eventIndex
        ) {
            violations.push('Historical correction invocation lacks a consecutive rejected-output retry.');
            return violations;
        }
        options.consumedInvocationAttestationIndexes.add(invocationAttestation.eventIndex);
        return violations;
    }
    if (acceptedResponses.length !== 1) {
        violations.push('Historical correction transport lacks exactly one accepted response.');
        return violations;
    }
    const acceptedResponse = acceptedResponses[0];
    const accepted = acceptedResponse.details;
    const acceptedMatches = (
        acceptedResponse.eventIndex > invocationAttestation.eventIndex
        && stringValue(accepted.task_id) === options.taskId
        && stringValue(accepted.review_type) === options.reviewType
        && stringValue(accepted.reviewer_identity) === stringValue(options.details.reviewer_identity)
        && !!stringValue(options.details.reviewer_attempt_id)
        && stringValue(accepted.reviewer_attempt_id) === stringValue(options.details.reviewer_attempt_id)
        && stringValue(accepted.correction_producer_identity)
            === stringValue(invocation.correction_producer_identity)
        && stringValue(accepted.provider_invocation_id) === stringValue(invocation.provider_invocation_id)
        && stringValue(accepted.attestation_source) === stringValue(invocation.attestation_source)
        && stringValue(accepted.provider_response_event_sha256)
            === stringValue(invocation.provider_response_event_sha256)
        && stringValue(accepted.corrected_output_sha256) === stringValue(invocation.corrected_output_sha256)
        && stringValue(accepted.selected_transport) === options.transport
        && stringValue(accepted.correction_artifact_path) === eventArtifactPath
        && stringValue(accepted.correction_artifact_sha256) === snapshot.artifact_sha256
        && stringValue(accepted.correction_package_sha256) === options.correctionPackageSha256
        && isSha256(stringValue(accepted.original_output_sha256))
        && isSha256(stringValue(accepted.findings_semantic_fingerprint))
        && stringValue(accepted.provider_id) === stringValue(options.details.provider_id)
        && stringValue(accepted.provider_capabilities_sha256)
            === stringValue(options.details.provider_capabilities_sha256)
        && stringValue(accepted.session_availability) === stringValue(options.details.session_availability)
    );
    if (!acceptedMatches) {
        violations.push('Historical correction acceptance is not bound to its transport and invocation.');
        return violations;
    }
    options.consumedInvocationAttestationIndexes.add(invocationAttestation.eventIndex);
    options.consumedAcceptedResponseIndexes.add(acceptedResponse.eventIndex);
    return violations;
}

function validateCurrentCorrectionArtifactChain(
    options: CorrectionArtifactChainValidationOptions
): CorrectionArtifactChainValidationResult {
    const violations: string[] = [];
    if (!isCanonicalCorrectionReviewType(options.reviewType)) {
        violations.push('Correction transport selection lacks a canonical review type.');
        return { artifact: null, eventArtifactPath: null, violations };
    }
    const expectedArtifactPath = getReviewOutputCorrectionArtifactPath(
        path.join(options.reviewsRoot, `${options.taskId}-${options.reviewType}.md`)
    );
    const eventArtifactPath = stringValue(options.details.correction_artifact_path);
    const resolvedEventArtifactPath = eventArtifactPath
        ? path.resolve(options.repoRoot, eventArtifactPath)
        : null;
    if (
        !resolvedEventArtifactPath
        || normalizePath(resolvedEventArtifactPath).toLowerCase()
            !== normalizePath(path.resolve(expectedArtifactPath)).toLowerCase()
    ) {
        violations.push('Correction transport selection does not reference its canonical correction artifact.');
        return { artifact: null, eventArtifactPath, violations };
    }
    const persistedRead = readCachedCorrectionArtifact(expectedArtifactPath, options.artifactCache);
    if (persistedRead.violations.length > 0 || !persistedRead.artifact) {
        violations.push('Correction transport selection lacks an intact persisted correction artifact.');
        return { artifact: null, eventArtifactPath, violations };
    }
    const persisted = persistedRead.artifact;
    if (
        persisted.task_id !== options.taskId
        || persisted.review_type !== options.reviewType
    ) {
        violations.push('Persisted correction transport artifact has mismatched task or review bindings.');
    }
    if (persisted.recovery.correction_attempt !== options.correctionAttempt) {
        violations.push('Persisted correction artifact does not match transport event correction attempt.');
    }
    if (persisted.recovery.selected_transport !== options.transport) {
        violations.push('Persisted correction artifact does not contain the selected transport.');
    }
    if (
        options.transport !== 'full_reviewer_relaunch'
        && !correctionArtifactDerivesFromPredecessorPackage({
            artifact: persisted,
            predecessorPackageSha256: stringValue(
                options.details.previous_correction_package_sha256
            )
        })
    ) {
        violations.push(
            'Persisted correction artifact is not derived from its validation-rejection predecessor package.'
        );
    }
    const binding = persisted.transport_binding;
    const attestation = binding?.availability_attestation;
    const acceptedApiContinuation = (
        persisted.state === 'CORRECTION_ACCEPTED'
        && options.transport === 'api_conversation_continuation'
    );
    if (
        !binding
        || binding.provider_id !== stringValue(options.details.provider_id)
        || binding.provider_invocation_id !== stringValue(options.details.provider_invocation_id)
        || binding.provider_capabilities_sha256
            !== stringValue(options.details.provider_capabilities_sha256)
        || binding.session_availability !== stringValue(options.details.session_availability)
        || persisted.binding.reviewer_identity !== stringValue(options.details.reviewer_identity)
        || persisted.binding.reviewer_attempt_id !== stringValue(options.details.reviewer_attempt_id)
        || persisted.binding.reviewer_invocation_event_sha256
            !== stringValue(options.details.reviewer_invocation_event_sha256)
        || (!acceptedApiContinuation && (
            (attestation?.attestation_source || null)
                !== stringValue(options.details.availability_attestation_source)
            || (attestation?.evidence_type || null)
                !== stringValue(options.details.availability_evidence_type)
            || (attestation?.provider_invocation_event_sha256 || null)
                !== stringValue(options.details.availability_provider_invocation_event_sha256)
            || (attestation?.provider_response_sha256 || null)
                !== stringValue(options.details.availability_provider_response_sha256)
        ))
    ) {
        violations.push('Persisted correction artifact does not match transport event provenance.');
    }
    if (persisted.state !== 'CORRECTION_ACCEPTED') {
        const persistedFileSha256 = readCachedCorrectionArtifactSha256(
            expectedArtifactPath,
            options.artifactCache
        );
        if (persistedFileSha256 !== options.correctionPackageSha256) {
            violations.push('Persisted correction artifact file hash does not match transport telemetry.');
        }
        if (persisted.artifact_sha256 !== stringValue(options.details.correction_artifact_sha256)) {
            violations.push('Persisted correction artifact content hash does not match transport telemetry.');
        }
    } else if (!selectionArtifactSnapshotMatches(options)) {
        violations.push('Persisted accepted correction artifact is not bound to its selected package snapshot.');
    }
    return { artifact: persisted, eventArtifactPath, violations };
}

function validatePersistedCorrectionTransport(
    options: CurrentCorrectionTransportValidationOptions
): string[] {
    const artifactValidation = validateCurrentCorrectionArtifactChain(options);
    const violations = artifactValidation.violations;
    const persisted = artifactValidation.artifact;
    const eventArtifactPath = artifactValidation.eventArtifactPath;
    if (!persisted || !eventArtifactPath) {
        return violations;
    }
    const binding = persisted.transport_binding;
    const attestation = binding?.availability_attestation;
    if (
        persisted.state === 'CORRECTION_ACCEPTED'
        && options.transport !== 'full_reviewer_relaunch'
    ) {
        const responseAttestation = options.transport === 'correction_only_invocation'
            ? persisted.producer_response_attestation
            : attestation;
        const matchingAcceptedResponses = responseAttestation
            ? filterCorrectionEvents(
                options.acceptedResponses,
                options.artifactCache.workMetrics,
                ({ details: accepted }) => (
                    stringValue(accepted.task_id) === options.taskId
                    && stringValue(accepted.review_type) === options.reviewType
                    && stringValue(accepted.selected_transport) === options.transport
                    && stringValue(accepted.reviewer_identity) === persisted.binding.reviewer_identity
                    && stringValue(accepted.reviewer_attempt_id) === persisted.binding.reviewer_attempt_id
                    && stringValue(accepted.correction_producer_identity) === responseAttestation.reviewer_identity
                    && stringValue(accepted.provider_invocation_id) === responseAttestation.provider_invocation_id
                    && stringValue(accepted.attestation_source) === responseAttestation.attestation_source
                    && stringValue(accepted.provider_response_event_sha256)
                        === responseAttestation.provider_response_event_sha256
                    && stringValue(accepted.corrected_output_sha256) === responseAttestation.provider_response_sha256
                    && stringValue(accepted.correction_artifact_path) === eventArtifactPath
                    && stringValue(accepted.correction_artifact_sha256) === persisted.artifact_sha256
                    && stringValue(accepted.correction_package_sha256) === options.correctionPackageSha256
                    && stringValue(accepted.original_output_sha256) === persisted.binding.original_output_sha256
                    && stringValue(accepted.findings_semantic_fingerprint)
                        === persisted.binding.findings_semantic_fingerprint
                    && stringValue(accepted.provider_id) === binding?.provider_id
                    && stringValue(accepted.provider_capabilities_sha256)
                        === binding?.provider_capabilities_sha256
                    && stringValue(accepted.session_availability) === binding?.session_availability
                )
            )
            : [];
        const acceptedResponse = matchingAcceptedResponses.length === 1
            ? matchingAcceptedResponses[0]
            : null;
        const matchingInvocationAttestations = responseAttestation
            ? filterCorrectionEvents(
                options.invocationAttestations,
                options.artifactCache.workMetrics,
                ({ details: invocation }) => (
                    stringValue(invocation.task_id) === options.taskId
                    && stringValue(invocation.review_type) === options.reviewType
                    && stringValue(invocation.original_reviewer_identity)
                        === persisted.binding.reviewer_identity
                    && stringValue(invocation.reviewer_attempt_id)
                        === persisted.binding.reviewer_attempt_id
                    && stringValue(invocation.correction_producer_identity)
                        === responseAttestation.reviewer_identity
                    && stringValue(invocation.provider_invocation_id)
                        === responseAttestation.provider_invocation_id
                    && stringValue(invocation.attestation_source)
                        === responseAttestation.attestation_source
                    && stringValue(invocation.corrected_output_sha256)
                        === responseAttestation.provider_response_sha256
                    && stringValue(invocation.provider_response_event_sha256)
                        === responseAttestation.provider_response_event_sha256
                    && typeof invocation.correction_attempt === 'number'
                    && invocation.correction_attempt === options.correctionAttempt
                    && stringValue(invocation.reviewer_invocation_event_sha256)
                        === stringValue(options.details.reviewer_invocation_event_sha256)
                    && stringValue(invocation.selected_transport) === options.transport
                    && stringValue(invocation.correction_package_sha256)
                        === options.correctionPackageSha256
                    && stringValue(invocation.provider_id) === binding?.provider_id
                    && stringValue(invocation.provider_capabilities_sha256)
                        === binding?.provider_capabilities_sha256
                    && stringValue(invocation.session_availability) === binding?.session_availability
                )
            )
            : [];
        const invocationAttestation = matchingInvocationAttestations.length === 1
            ? matchingInvocationAttestations[0]
            : null;
        const acceptedResponseIsOrdered = !!acceptedResponse
            && acceptedResponse.eventIndex > options.selectedEventIndex
            && !options.consumedAcceptedResponseIndexes.has(acceptedResponse.eventIndex);
        const invocationAttestationIsOrdered = !!invocationAttestation
            && invocationAttestation.eventIndex > options.selectedEventIndex
            && !!acceptedResponse
            && invocationAttestation.eventIndex < acceptedResponse.eventIndex
            && !options.consumedInvocationAttestationIndexes.has(invocationAttestation.eventIndex);
        if (
            !acceptedResponseIsOrdered
            || violations.length > 0
        ) {
            violations.push(
                'Correction transport acceptance is not bound to the current attempt and persisted artifact.'
            );
        }
        if (
            !invocationAttestationIsOrdered
            || violations.length > 0
        ) {
            violations.push(
                'Correction transport package is not bound to its provider invocation attestation.'
            );
        }
        if (acceptedResponseIsOrdered && invocationAttestationIsOrdered && violations.length === 0) {
            options.consumedAcceptedResponseIndexes.add(acceptedResponse.eventIndex);
            options.consumedInvocationAttestationIndexes.add(invocationAttestation.eventIndex);
        }
    }
    if (
        persisted.state !== 'CORRECTION_ACCEPTED'
        && options.transport !== 'full_reviewer_relaunch'
    ) {
        violations.push('Correction transport selection lacks accepted provider response provenance.');
    }
    return violations;
}

function validateCorrectionTransportReconstruction(options: {
    current: CurrentCorrectionTransportValidationOptions;
    historical: Omit<
        HistoricalCorrectionTransportValidationOptions,
        keyof CurrentCorrectionTransportValidationOptions
    > | null;
}): string[] {
    return options.historical
        ? validateHistoricalCorrectionTransport({
            ...options.current,
            ...options.historical
        })
        : validatePersistedCorrectionTransport(options.current);
}

function collectCorrectionTransports(
    events: readonly ReviewReuseTelemetryEventLike[],
    options: {
        repoRoot: string;
        reviewsRoot: string;
        taskId: string;
        authorizedReviewTypes: ReadonlySet<string>;
        onWorkMetrics?: (metrics: Readonly<CorrectionTransportWorkMetrics>) => void;
    }
): ReviewOutputCorrectionTransportAudit[] {
    const workMetrics: CorrectionTransportWorkMetrics = {
        timeline_events_indexed: 0,
        evidence_events_windowed: 0,
        evidence_candidates_examined: 0,
        selection_candidates_examined: 0,
        artifact_reads: 0,
        artifact_read_cache_hits: 0,
        artifact_hash_reads: 0,
        artifact_hash_cache_hits: 0
    };
    const eventCollection = collectCorrectionTransportEvents(events, {
        ...options,
        workMetrics
    });
    const {
        transportEvents,
        acceptedCorrectionResponses,
        correctionInvocationAttestations,
        evidenceWindowsBySelectionIndex,
        reviewerInvocationsBySha256,
        selectionsByPreviousPackage,
        selectionEventsByIndex,
        nextSelectionIndexByEventIndex
    } = eventCollection;
    const requiredPackages = new Map<string, {
        eventIndex: number;
        reviewType: string;
        correctionAttempt: number;
        reviewerIdentity: string;
        reviewerAttemptId: string;
        providerInvocationId: string | null;
        reviewerInvocationEventSha256: string;
    }>();
    const observedRejectionPackages = new Set<string>();
    const selectedPreviousPackages = new Set<string>();
    const consumedAcceptedResponseIndexes = new Set<number>();
    const consumedInvocationAttestationIndexes = new Set<number>();
    const artifactCache: CorrectionArtifactCache = {
        entries: new Map<string, CorrectionArtifactCacheEntry>(),
        workMetrics
    };
    const results: ReviewOutputCorrectionTransportAudit[] = [];
    for (const {
        eventIndex: selectedEventIndex,
        timestampUtc,
        eventType,
        transport,
        details
    } of transportEvents) {
        const correctionPackageSha256 = stringValue(details.correction_package_sha256);
        const previousPackageSha256 = stringValue(details.previous_correction_package_sha256);
        const providerCapabilitiesSha256 = stringValue(details.provider_capabilities_sha256);
        const eventTaskId = stringValue(details.task_id);
        const reviewTypeValue = stringValue(details.review_type);
        const reviewType = reviewTypeValue || 'unknown';
        const sessionAvailability = stringValue(details.session_availability);
        const reviewerIdentity = stringValue(details.reviewer_identity);
        const reviewerAttemptId = stringValue(details.reviewer_attempt_id);
        const providerId = stringValue(details.provider_id);
        const providerInvocationId = stringValue(details.provider_invocation_id);
        const reviewerInvocationEventSha256 = stringValue(details.reviewer_invocation_event_sha256);
        const correctionAttemptValue = details.correction_attempt;
        const correctionAttempt = typeof correctionAttemptValue === 'number'
            && Number.isInteger(correctionAttemptValue)
            && correctionAttemptValue > 0
            ? correctionAttemptValue
            : null;
        const violations: string[] = [];
        const syntacticallyCanonicalReviewType = isCanonicalCorrectionReviewType(reviewTypeValue);
        const canonicalReviewType = syntacticallyCanonicalReviewType
            && options.authorizedReviewTypes.has(reviewTypeValue);
        const trustedOriginalReviewerInvocation = hasTrustedOriginalReviewerInvocation({
            reviewerInvocationsBySha256,
            eventIndex: selectedEventIndex,
            taskId: options.taskId,
            reviewType,
            reviewerIdentity,
            reviewerAttemptId,
            providerId,
            providerInvocationId,
            reviewerInvocationEventSha256
        });
        if (eventTaskId !== options.taskId) {
            violations.push('Correction transport event is not bound to the audited task.');
        }
        if (!syntacticallyCanonicalReviewType) {
            violations.push('Correction transport event lacks a canonical review type.');
        } else if (!canonicalReviewType) {
            violations.push('Correction transport event review type is not authorized for the audited task.');
        }
        if (!isSha256(correctionPackageSha256)) {
            violations.push('Correction transport event lacks a valid correction package hash.');
        }
        if (!correctionAttempt) {
            violations.push('Correction transport event lacks a positive correction attempt.');
        }
        if (!trustedOriginalReviewerInvocation) {
            violations.push(
                'Correction transport event does not match a trusted original reviewer invocation.'
            );
        }
        if (transport === 'validation_rejection') {
            if (!reviewerIdentity) {
                violations.push('Correction validation rejection lacks reviewer identity evidence.');
            }
            if (!reviewerAttemptId) {
                violations.push('Correction validation rejection lacks reviewer attempt evidence.');
            }
            if (!isSha256(reviewerInvocationEventSha256)) {
                violations.push('Correction validation rejection lacks reviewer invocation evidence.');
            }
            if (
                isSha256(correctionPackageSha256)
                && correctionAttempt
                && reviewerIdentity
                && reviewerAttemptId
                && isSha256(reviewerInvocationEventSha256)
                && eventTaskId === options.taskId
                && canonicalReviewType
                && trustedOriginalReviewerInvocation
            ) {
                const duplicateRejection = observedRejectionPackages.has(correctionPackageSha256);
                observedRejectionPackages.add(correctionPackageSha256);
                if (duplicateRejection) {
                    violations.push(
                        'Correction validation rejection is duplicate or replayed for the same correction package.'
                    );
                }
                const hasSuccessorSelection = !duplicateRejection && hasCorrectionSelection(
                    selectionsByPreviousPackage.get(correctionPackageSha256) || [],
                    workMetrics,
                    (selection) => correctionSelectionMatchesValidationRejection({
                        selection,
                        rejectionEventIndex: selectedEventIndex,
                        taskId: options.taskId,
                        reviewType,
                        correctionAttempt,
                        reviewerIdentity,
                        reviewerAttemptId,
                        providerId,
                        providerInvocationId,
                        reviewerInvocationEventSha256
                    })
                );
                const rejectionArtifactViolations = duplicateRejection || hasSuccessorSelection
                    ? []
                    : validateTerminalCorrectionRejectionArtifact({
                        repoRoot: options.repoRoot,
                        reviewsRoot: options.reviewsRoot,
                        taskId: options.taskId,
                        reviewType,
                        correctionAttempt,
                        correctionPackageSha256,
                        reviewerIdentity,
                        reviewerAttemptId,
                        providerId,
                        providerInvocationId,
                        reviewerInvocationEventSha256,
                        details,
                        artifactCache
                    });
                violations.push(...rejectionArtifactViolations);
                if (!duplicateRejection && rejectionArtifactViolations.length === 0) {
                    requiredPackages.set(correctionPackageSha256, {
                        eventIndex: selectedEventIndex,
                        reviewType,
                        correctionAttempt,
                        reviewerIdentity,
                        reviewerAttemptId,
                        providerInvocationId,
                        reviewerInvocationEventSha256
                    });
                }
            }
        } else if (
            transport === 'live_reviewer_continuation'
            || transport === 'api_conversation_continuation'
            || transport === 'correction_only_invocation'
            || transport === 'full_reviewer_relaunch'
        ) {
            if (transport === 'full_reviewer_relaunch') {
                if (previousPackageSha256) {
                    violations.push(
                        'FULL reviewer relaunch must bind directly to its current correction package.'
                    );
                }
            } else {
                const predecessorPackageSha256 = isSha256(previousPackageSha256)
                    ? previousPackageSha256
                    : null;
                const predecessor = predecessorPackageSha256
                    ? requiredPackages.get(predecessorPackageSha256)
                    : null;
                if (
                    !predecessorPackageSha256
                    || !predecessor
                    || predecessor.eventIndex >= selectedEventIndex
                ) {
                    violations.push(
                        'Correction transport selection is stale or lacks its validation-rejection predecessor.'
                    );
                } else if (selectedPreviousPackages.has(predecessorPackageSha256)) {
                    violations.push('Correction transport selection is duplicate or raced for the same correction package.');
                } else if (
                    eventTaskId === options.taskId
                    && trustedOriginalReviewerInvocation
                ) {
                    selectedPreviousPackages.add(predecessorPackageSha256);
                    if (
                        predecessor.reviewType !== reviewType
                        || predecessor.correctionAttempt !== correctionAttempt
                        || predecessor.reviewerIdentity !== reviewerIdentity
                        || predecessor.reviewerAttemptId !== reviewerAttemptId
                        || predecessor.providerInvocationId !== providerInvocationId
                        || predecessor.reviewerInvocationEventSha256 !== reviewerInvocationEventSha256
                    ) {
                        violations.push('Correction transport selection does not match its delegated reviewer predecessor.');
                    }
                }
                if (previousPackageSha256 === correctionPackageSha256) {
                    violations.push('Correction transport selection did not freeze a new attested package generation.');
                }
            }
            const providerCapabilities = isPlainRecord(details.provider_capabilities)
                ? details.provider_capabilities
                : null;
            if (!providerCapabilities || !isSha256(providerCapabilitiesSha256)) {
                violations.push('Correction transport selection lacks provider capability evidence.');
            } else {
                const normalizedCapabilities = {
                    live_reviewer_continuation:
                        providerCapabilities.live_reviewer_continuation === true,
                    api_conversation_continuation:
                        providerCapabilities.api_conversation_continuation === true,
                    correction_only_invocation:
                        providerCapabilities.correction_only_invocation === true
                };
                const expectedCapabilitiesSha256 = computeReviewOutputCorrectionProviderCapabilitiesSha256({
                    providerId: stringValue(details.provider_id),
                    capabilities: normalizedCapabilities
                });
                if (expectedCapabilitiesSha256 !== providerCapabilitiesSha256) {
                    violations.push('Correction transport provider capability hash is unverifiable.');
                }
                if (
                    transport === 'live_reviewer_continuation'
                    && !normalizedCapabilities.live_reviewer_continuation
                ) {
                    violations.push('Live continuation was selected without provider capability evidence.');
                }
                if (
                    transport === 'api_conversation_continuation'
                    && !normalizedCapabilities.api_conversation_continuation
                ) {
                    violations.push('API continuation was selected without provider capability evidence.');
                }
                if (
                    transport === 'correction_only_invocation'
                    && !normalizedCapabilities.correction_only_invocation
                ) {
                    violations.push('Correction-only fallback was selected without provider capability evidence.');
                }
            }
            if (!providerInvocationId) {
                violations.push('Correction transport selection lacks the original provider invocation id.');
            }
            if (!isSha256(reviewerInvocationEventSha256)) {
                violations.push('Correction transport selection lacks reviewer invocation evidence.');
            }
            const availabilityAttestationSource = stringValue(details.availability_attestation_source);
            const availabilityEvidenceType = stringValue(details.availability_evidence_type);
            const availabilityProviderInvocationEventSha256 = stringValue(
                details.availability_provider_invocation_event_sha256
            );
            const availabilityProviderResponseSha256 = stringValue(
                details.availability_provider_response_sha256
            );
            const correctionSessionAvailability =
                sessionAvailability === 'available'
                || sessionAvailability === 'closed'
                || sessionAvailability === 'stateless'
                    ? sessionAvailability
                    : 'not_applicable';
            if (transport === 'live_reviewer_continuation') {
                if (
                    sessionAvailability !== 'available'
                    || availabilityEvidenceType !== 'provider_native_session_receipt'
                    || availabilityProviderInvocationEventSha256 !== reviewerInvocationEventSha256
                    || !isSha256(availabilityProviderResponseSha256)
                    || !isProviderOwnedReviewOutputCorrectionSessionAttestationSource(
                        availabilityAttestationSource || ''
                    )
                ) {
                    violations.push(
                        'Live continuation lacks an authenticated provider-owned session receipt.'
                    );
                }
            } else if (
                providerCapabilities
                && requiresReviewOutputCorrectionFailClosedAvailabilityEvidence({
                    sessionAvailability: correctionSessionAvailability,
                    selectedTransport: transport,
                    providerCapabilities: {
                        live_reviewer_continuation:
                            providerCapabilities.live_reviewer_continuation === true
                    }
                })
                && (
                availabilityAttestationSource !== REVIEW_OUTPUT_CORRECTION_FAIL_CLOSED_ATTESTATION_SOURCE
                || availabilityEvidenceType !== 'fail_closed_no_provider_session_receipt'
                )
            ) {
                violations.push('Correction transport selection lacks canonical fail-closed availability evidence.');
            }
            if (
                transport === 'correction_only_invocation'
                && !['closed', 'stateless'].includes(sessionAvailability || '')
            ) {
                violations.push('Correction-only fallback lacks closed or stateless session evidence.');
            }
            if (
                transport === 'api_conversation_continuation'
                && !['closed', 'stateless'].includes(sessionAvailability || '')
            ) {
                violations.push('API continuation lacks closed or stateless session evidence.');
            }
            const nextSelectedEventIndex = nextSelectionIndexByEventIndex.get(selectedEventIndex);
            const evidenceWindow = evidenceWindowsBySelectionIndex.get(selectedEventIndex) || {
                acceptedResponses: [],
                invocationAttestations: [],
                retryRejections: []
            };
            const transportValidationOptions = {
                ...options,
                reviewType,
                transport,
                correctionAttempt,
                correctionPackageSha256,
                details,
                acceptedResponses: evidenceWindow.acceptedResponses,
                invocationAttestations: evidenceWindow.invocationAttestations,
                selectedEventIndex,
                consumedAcceptedResponseIndexes,
                consumedInvocationAttestationIndexes,
                artifactCache
            };
            if (
                canonicalReviewType
                && eventTaskId === options.taskId
                && trustedOriginalReviewerInvocation
            ) {
                violations.push(...validateCorrectionTransportReconstruction({
                    current: transportValidationOptions,
                    historical: nextSelectedEventIndex === undefined
                        ? null
                        : {
                            retryRejections: evidenceWindow.retryRejections,
                            nextSelectionPreviousPackageSha256: stringValue(
                                selectionEventsByIndex
                                    .get(nextSelectedEventIndex)
                                    ?.details.previous_correction_package_sha256
                            )
                        }
                }));
            }
        }
        results.push({
            ...correctionAuditEventBinding(events[selectedEventIndex]),
            timestamp_utc: timestampUtc,
            event_type: eventType,
            review_type: reviewType,
            transport,
            session_availability: sessionAvailability,
            correction_attempt: correctionAttempt,
            correction_package_sha256: correctionPackageSha256,
            reviewer_invocation_event_sha256: reviewerInvocationEventSha256,
            provider_capabilities_sha256: providerCapabilitiesSha256,
            evidence_valid: violations.length === 0,
            violations
        });
    }
    for (const invocationAttestation of correctionInvocationAttestations) {
        const details = invocationAttestation.details;
        const evidenceValid = consumedInvocationAttestationIndexes.has(invocationAttestation.eventIndex)
            && stringValue(details.task_id) === options.taskId;
        results.push({
            ...correctionAuditEventBinding(events[invocationAttestation.eventIndex]),
            timestamp_utc: invocationAttestation.timestampUtc,
            event_type: 'REVIEW_OUTPUT_CORRECTION_INVOCATION_ATTESTED',
            review_type: stringValue(details.review_type) || 'unknown',
            transport: 'invocation_attestation',
            session_availability: stringValue(details.session_availability),
            correction_attempt: null,
            correction_package_sha256: stringValue(details.correction_package_sha256),
            reviewer_invocation_event_sha256: null,
            provider_capabilities_sha256: stringValue(details.provider_capabilities_sha256),
            evidence_valid: evidenceValid,
            violations: evidenceValid
                ? []
                : [
                    ...(stringValue(details.task_id) === options.taskId
                        ? []
                        : ['Correction invocation attestation is not bound to the audited task.']),
                    'Correction invocation attestation lacks exactly one matching transport acceptance chain.'
                ]
        });
    }
    for (const acceptedResponse of acceptedCorrectionResponses) {
        const details = acceptedResponse.details;
        const evidenceValid = consumedAcceptedResponseIndexes.has(acceptedResponse.eventIndex)
            && stringValue(details.task_id) === options.taskId;
        results.push({
            ...correctionAuditEventBinding(events[acceptedResponse.eventIndex]),
            timestamp_utc: acceptedResponse.timestampUtc,
            event_type: 'REVIEW_OUTPUT_CORRECTION_ACCEPTED',
            review_type: stringValue(details.review_type) || 'unknown',
            transport: 'acceptance',
            session_availability: stringValue(details.session_availability),
            correction_attempt: null,
            correction_package_sha256: stringValue(details.correction_package_sha256),
            reviewer_invocation_event_sha256: null,
            provider_capabilities_sha256: stringValue(details.provider_capabilities_sha256),
            evidence_valid: evidenceValid,
            violations: evidenceValid
                ? []
                : [
                    ...(stringValue(details.task_id) === options.taskId
                        ? []
                        : ['Correction acceptance is not bound to the audited task.']),
                    'Correction acceptance lacks exactly one matching prior transport selection.'
                ]
        });
    }
    options.onWorkMetrics?.({ ...workMetrics });
    return results;
}

export function buildReviewFindingsAuditSummary(options: {
    repoRoot: string;
    reviewsRoot: string;
    taskId: string;
    requiredReviews: Record<string, boolean>;
    authorizedCorrectionReviewTypes?: readonly string[];
    currentPreflight: Record<string, unknown> | null;
    timelineEvents: readonly ReviewReuseTelemetryEventLike[];
    reviewAttemptSummary: ReviewAttemptSummary | null;
    currentCycle?: TaskCycleBindingSnapshot | null;
    reviewIntegrityAttestation?: FinalCloseoutReviewIntegrityAttestation | null;
    timelineIntegrityStatus?: string;
    currentPreflightSha256?: string | null;
    taskQueueEntries?: ReadonlyMap<string, TaskQueueEntry>;
    _testHooks?: {
        onCorrectionTransportWorkMetrics?: (
            metrics: Readonly<CorrectionTransportWorkMetrics>
        ) => void;
    };
}): ReviewFindingsAuditSummary | null {
    const closurePolicyResolution = resolveLockedReviewFindingPolicyFromPreflight(
        options.currentPreflight
    );
    const closurePolicy = closurePolicyResolution.follow_up_task_closure_policy;
    const validationFailures = collectValidationFailures(options.timelineEvents);
    const remediationCycles = collectRemediationCycles(options.timelineEvents);
    const requiredReviewTypes = collectKnownRequiredReviewTypes(
        options.requiredReviews,
        options.currentPreflight
    );
    const correctionTransports = scopeCorrectionTransports({
        ...options,
        requiredReviewTypes,
        transports: collectCorrectionTransports(options.timelineEvents, {
            ...options,
            authorizedReviewTypes: new Set(
                options.authorizedCorrectionReviewTypes || requiredReviewTypes
            ),
            onWorkMetrics: options._testHooks?.onCorrectionTransportWorkMetrics
        })
    });
    const lanes = requiredReviewTypes
        .map((reviewType) => buildCurrentFindingsLane({ ...options, reviewType }))
        .filter((lane): lane is ReviewFindingsAuditLane => lane !== null)
        .sort((left, right) => left.review_type.localeCompare(right.review_type));
    if (
        lanes.length === 0
        && validationFailures.length === 0
        && remediationCycles.length === 0
        && correctionTransports.length === 0
        && !closurePolicy.eligible
    ) {
        return null;
    }
    const findings = lanes.flatMap((lane) => lane.findings);
    const dispositionCounts = lanes.reduce((counts, lane) => ({
        fix_now: counts.fix_now + lane.disposition_counts.fix_now,
        create_follow_up: counts.create_follow_up + lane.disposition_counts.create_follow_up,
        ignore: counts.ignore + lane.disposition_counts.ignore
    }), { fix_now: 0, create_follow_up: 0, ignore: 0 });
    const remainingBlockerCount = lanes.reduce((count, lane) => (
        count
        + lane.remaining_blocker_ids.length
        + (lane.validation_violations.length > 0 ? 1 : 0)
        + (lane.remaining_blocker_ids.length === 0 && lane.disposition_violations.length > 0 ? 1 : 0)
    ), 0) + correctionTransports.filter((entry) => (
        !entry.evidence_valid && entry.audit_scope !== 'SUPERSEDED_CYCLE'
    )).length;
    const supersededInvalidTransportCount = correctionTransports.filter((entry) => (
        !entry.evidence_valid && entry.audit_scope === 'SUPERSEDED_CYCLE'
    )).length;
    const reusedReviewCount = Object.values(options.reviewAttemptSummary?.fresh_reused_by_review_type || {})
        .reduce((count, entry) => count + entry.reused, 0);
    const freshReviewCount = options.reviewAttemptSummary?.total_attempts || 0;
    const hasIncompleteLane = lanes.some((lane) => (
        lane.validation_status === 'MISSING_OR_INVALID'
        || (lane.validation_status === 'ACCEPTED' && lane.disposition_status === 'NOT_AVAILABLE')
    ));
    const status: ReviewFindingsAuditSummary['status'] = remainingBlockerCount > 0
        ? hasIncompleteLane ? 'INCOMPLETE' : 'BLOCKED'
        : 'CLEAR';
    const ignoredLowFindingsCount = findings.filter((item) => (
        item.kind === 'finding'
        && item.severity === 'low'
        && item.action === 'ignore'
        && item.source_rule === 'review_follow_up_task_closure_policy.skip_low_findings'
    )).length;
    const retainedCurrentTaskCount = findings.filter((item) => (
        item.action === 'fix_now'
        && item.source_rule === 'review_follow_up_task_closure_policy.forbid_child_tasks'
    )).length;
    const closurePolicySource: 'preflight_profile_policy_snapshot' | 'legacy_default' =
        closurePolicyResolution.follow_up_task_closure_policy_source
        === 'preflight_profile_policy_snapshot'
        ? 'preflight_profile_policy_snapshot'
        : 'legacy_default';
    const closurePolicySummary = closurePolicy.eligible
        ? {
            source: closurePolicySource,
            eligible: closurePolicy.eligible,
            configured: closurePolicy.configured,
            valid: closurePolicy.valid,
            provenance: closurePolicy.provenance,
            source_notes_sha256: closurePolicy.source_notes_sha256,
            skip_low_findings: closurePolicy.skip_low_findings,
            forbid_child_tasks: closurePolicy.forbid_child_tasks,
            ignored_low_findings_count: ignoredLowFindingsCount,
            retained_current_task_count: retainedCurrentTaskCount,
            prohibited_descendant_creation_count: retainedCurrentTaskCount,
            remaining_blocker_count: findings.filter((item) => (
                item.blocking
                && item.source_rule === 'review_follow_up_task_closure_policy.forbid_child_tasks'
            )).length,
            diagnostics: [...closurePolicy.diagnostics],
            visible_summary_line:
                `F-task closure policy: source=${closurePolicySource}; `
                + `provenance=${closurePolicy.provenance || 'none'}; valid=${closurePolicy.valid}; `
                + `skip_low_findings=${closurePolicy.skip_low_findings}; `
                + `forbid_child_tasks=${closurePolicy.forbid_child_tasks}; `
                + `ignored_low=${ignoredLowFindingsCount}; retained_current_task=${retainedCurrentTaskCount}; `
                + `prohibited_descendants=${retainedCurrentTaskCount}.`
        }
        : null;
    return {
        status,
        lanes,
        finding_count: findings.filter((item) => item.kind === 'finding').length,
        residual_risk_count: findings.filter((item) => item.kind === 'residual_risk').length,
        disposition_counts: dispositionCounts,
        remaining_blocker_count: remainingBlockerCount,
        validation_failures: validationFailures,
        remediation_cycles: remediationCycles,
        correction_transports: correctionTransports,
        superseded_invalid_transport_count: supersededInvalidTransportCount,
        fresh_review_count: freshReviewCount,
        reused_review_count: reusedReviewCount,
        review_follow_up_task_closure_policy: closurePolicySummary,
        visible_summary_line:
            `Review findings audit: status=${status}; lanes=${lanes.length}; findings=${findings.filter((item) => item.kind === 'finding').length}; ` +
            `residual_risks=${findings.filter((item) => item.kind === 'residual_risk').length}; ` +
            `fix_now=${dispositionCounts.fix_now}; follow_up=${dispositionCounts.create_follow_up}; ignored=${dispositionCounts.ignore}; ` +
            `remaining_blockers=${remainingBlockerCount}; validation_failures=${validationFailures.length}; ` +
            `remediation_cycles=${remediationCycles.length}; fresh_reviews=${freshReviewCount}; reused_reviews=${reusedReviewCount}`
            + (supersededInvalidTransportCount > 0
                ? `; superseded_invalid_transports=${supersededInvalidTransportCount}` : '')
    };
}
