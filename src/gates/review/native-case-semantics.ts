import * as path from 'node:path';
import type { TrustBoundarySourceEvidence } from '../../core/trust-boundary-analysis';
import { MAX_BOUNDARY_SOURCE_REFERENCES, readBoundarySourceEvidence } from '../../core/trust-boundary-source-evidence';
import { readValidationFile, validationDigest } from '../../core/project-validation-identity';
import { isPlainRecord } from '../../core/records';
import type { QualityValidationObligation } from '../quality-checklist/quality-checklist-validation-phases';
import { validationPaths } from '../project-validation/authority';
import type { ValidationEvidenceInspection } from '../project-validation/attempt-evidence';
import { readTaskOwnedIntermediateExecutionEvidence } from './focused-intermediate-evidence';

const MAX_CONTROL_BYTES = 8 * 1024 * 1024;
const MAX_QUOTE_CHARS = 4096;
const MAX_REASON_CHARS = 8192;
const HASH = /^[a-f0-9]{64}$/u;

export interface NativeCaseExecution {
    record_path: string; record_sha256: string; output_path: string; output_sha256: string;
    output_size_bytes: number; output_encoding: 'utf8' | 'base64-streams';
    event_task_sequence: number; scope_content_sha256: string;
}
export interface NativeCaseResolution {
    binding_sha256: string; execution_sha256: string; output_sha256: string;
    outcome: 'PASSED' | 'FAILED' | 'SKIPPED' | 'UNRESOLVED';
    evidence_quote: string; reasoning: string;
}

export function readNativeCaseObligations(options: {
    repoRoot: string; taskId: string; preflightPath: string; preflightSha256: string;
    scopeContentSha256: string; sources: readonly TrustBoundarySourceEvidence[];
    inspection?: ValidationEvidenceInspection;
}): QualityValidationObligation[] {
    if (!options.sources.length) return [];
    const timelinePath = validationPaths(options.repoRoot, options.taskId).timeline;
    const timeline = readValidationFile(options.repoRoot, timelinePath, MAX_CONTROL_BYTES);
    const root = path.join(options.repoRoot, path.dirname(timelinePath));
    const proof = readTaskOwnedIntermediateExecutionEvidence({ repoRoot: options.repoRoot, taskId: options.taskId,
        reviewsRoot: path.join(root, '../reviews'), eventsRoot: root, inspection: options.inspection,
        expectedPreflightPath: options.preflightPath, expectedPreflightSha256: options.preflightSha256,
        expectedScopeContentSha256: options.scopeContentSha256, maxTimelineBytes: MAX_CONTROL_BYTES,
        maxTimelineEvents: 10_000 });
    const latest = proof.entries.find(entry => entry.command_source !== 'typecheck');
    if (!latest) throw new Error(`Native case execution is unavailable: ${proof.warnings.join(' ')}`);
    const sources = readBoundarySourceEvidence({ repoRoot: options.repoRoot,
        references: options.sources.map(source => ({ filePath: source.source_identity.path, caseId: source.case_id })),
        expectedSources: [...new Map(options.sources.map(source => [source.source_identity.path, source.source_identity])).values()] });
    if (sources.violations.length) throw new Error(sources.violations.join(' '));
    const execution: NativeCaseExecution = { record_path: latest.artifact_path, record_sha256: latest.artifact_sha256,
        output_path: latest.output_artifact_path, output_sha256: latest.output_artifact_sha256,
        output_size_bytes: latest.output_artifact_size_bytes, output_encoding: 'utf8',
        event_task_sequence: latest.event_task_sequence, scope_content_sha256: options.scopeContentSha256 };
    const obligations = sources.sourceEvidence.map(source => {
        const binding = { task_id: options.taskId, preflight_sha256: options.preflightSha256,
            source_identity: source.source_identity, case_id: source.case_id, case_execution: execution };
        return { id: validationDigest(binding), recipe_id: 'native-task-command', target_id: source.case_id,
            selector: source.case_id, source_identity: source.source_identity, snapshot_sha256: options.preflightSha256,
            execution: 'OBSERVED' as const, attempt_id: latest.artifact_sha256, result_status: 'UNRESOLVED',
            result_sha256: null, case_execution: { ...execution } };
    });
    if (new Set(obligations.map(item => item.id)).size !== obligations.length)
        throw new Error('Native case source references are ambiguous.');
    if (readValidationFile(options.repoRoot, timelinePath, MAX_CONTROL_BYTES).identity.sha256 !== timeline.identity.sha256)
        throw new Error('Native case timeline changed during projection.');
    const preflightRelative = path.relative(path.resolve(options.repoRoot),
        path.resolve(options.repoRoot, options.preflightPath)).replace(/\\/gu, '/');
    if (readValidationFile(options.repoRoot, preflightRelative, MAX_CONTROL_BYTES).identity.sha256 !== options.preflightSha256)
        throw new Error('Native case preflight changed during projection.');
    return obligations;
}

function resolutionShape(value: unknown): value is NativeCaseResolution {
    if (!isPlainRecord(value) || Object.keys(value).some(key => !['binding_sha256', 'execution_sha256',
        'output_sha256', 'outcome', 'evidence_quote', 'reasoning'].includes(key))) return false;
    return ['binding_sha256', 'execution_sha256', 'output_sha256'].every(key =>
        typeof value[key] === 'string' && HASH.test(value[key] as string))
        && typeof value.outcome === 'string'
        && ['PASSED', 'FAILED', 'SKIPPED', 'UNRESOLVED'].includes(value.outcome)
        && typeof value.evidence_quote === 'string' && value.evidence_quote.length <= MAX_QUOTE_CHARS
        && typeof value.reasoning === 'string' && !!value.reasoning.trim() && value.reasoning.length <= MAX_REASON_CHARS;
}

function retainedOutput(repoRoot: string, execution: NativeCaseExecution): { text: string; relative: string } {
    const relative = path.relative(path.resolve(repoRoot), path.resolve(repoRoot, execution.output_path)).replace(/\\/gu, '/');
    const file = readValidationFile(repoRoot, relative, MAX_CONTROL_BYTES);
    if (file.identity.sha256 !== execution.output_sha256 || file.bytes.length !== execution.output_size_bytes)
        throw new Error('Native case output identity changed.');
    if (execution.output_encoding === 'utf8') return { text: file.bytes.toString('utf8'), relative };
    if (execution.output_encoding !== 'base64-streams') throw new Error('Unknown native output encoding.');
    const streams: unknown = JSON.parse(file.bytes.toString('utf8'));
    if (!isPlainRecord(streams)) throw new Error('Native output streams are malformed.');
    const decoded = ['stdout_base64', 'stderr_base64'].map(key => {
        if (typeof streams[key] !== 'string') throw new Error('Native output stream is missing.');
        const bytes = Buffer.from(streams[key] as string, 'base64');
        if (bytes.toString('base64') !== streams[key]) throw new Error('Native output encoding is not canonical.');
        return bytes.toString('utf8');
    });
    return { text: decoded.join('\n'), relative };
}

/** Binding/quotation validation does not interpret a report format or decide case semantics. */
export function getNativeCaseResolutionViolations(options: {
    obligations: readonly QualityValidationObligation[];
    entries: readonly { obligation_id: string; case_resolution?: unknown }[];
    repoRoot?: string; requirePassed?: boolean;
}): string[] {
    const nativeBindings = options.obligations.filter(binding => binding.case_execution);
    if (nativeBindings.length > MAX_BOUNDARY_SOURCE_REFERENCES) return ['Native case obligations exceed their bound.'];
    if (nativeBindings.length === 0) return [];
    if (options.requirePassed && !options.repoRoot)
        return ['Native case terminal closure requires actual retained source, record and output inspection.'];
    const violations: string[] = [], outputs = new Map<string, { text: string; relative: string; digest: string }>();
    const sources = new Map<string, string>();
    const records = new Map<string, string>();
    const entriesById = new Map<string, typeof options.entries[number][]>();
    for (const entry of options.entries) {
        const matches = entriesById.get(entry.obligation_id) ?? [];
        matches.push(entry); entriesById.set(entry.obligation_id, matches);
    }
    for (const binding of nativeBindings) {
        const execution = binding.case_execution;
        if (!execution) continue;
        const id = `VALIDATION-${binding.id.toUpperCase()}`;
        const matches = entriesById.get(id) ?? [];
        const resolution = matches[0]?.case_resolution;
        if (matches.length !== 1 || !resolutionShape(resolution)) {
            violations.push(`${id}: current independent case resolution is missing or malformed.`); continue;
        }
        if (resolution.binding_sha256 !== validationDigest(binding) || resolution.execution_sha256 !== execution.record_sha256
            || resolution.output_sha256 !== execution.output_sha256 || binding.execution !== 'OBSERVED')
            violations.push(`${id}: independent case resolution has foreign source/execution/output bindings.`);
        if (options.requirePassed && resolution.outcome !== 'PASSED')
            violations.push(`${id}: selected case remains ${resolution.outcome}; source coverage is not result closure.`);
        if (resolution.outcome === 'UNRESOLVED') continue;
        if (!resolution.evidence_quote.trim()) {
            violations.push(`${id}: a resolved outcome requires actual retained output evidence.`); continue;
        }
        if (!options.repoRoot) continue; // Structural schema/unit inspection; native consumers supply repoRoot.
        try {
            const record = path.relative(path.resolve(options.repoRoot),
                path.resolve(options.repoRoot, execution.record_path)).replace(/\\/gu, '/');
            if (!records.has(record)) records.set(record,
                readValidationFile(options.repoRoot, record, MAX_CONTROL_BYTES).identity.sha256);
            if (records.get(record) !== execution.record_sha256) throw new Error('Native case execution record changed.');
            const source = binding.source_identity;
            const expected = validationDigest(source);
            if (!sources.has(source.path)) sources.set(source.path,
                validationDigest(readValidationFile(options.repoRoot, source.path, MAX_CONTROL_BYTES).identity));
            if (sources.get(source.path) !== expected) throw new Error('Native case source identity changed.');
            const key = validationDigest(execution);
            if (!outputs.has(key)) outputs.set(key, { ...retainedOutput(options.repoRoot, execution), digest: execution.output_sha256 });
            if (!outputs.get(key)!.text.includes(resolution.evidence_quote))
                violations.push(`${id}: the independent quotation is absent from actual retained output.`);
        } catch (error) { violations.push(`${id}: retained case evidence rejected: ${String(error)}`); }
    }
    for (const output of outputs.values()) {
        try {
            if (readValidationFile(options.repoRoot!, output.relative, MAX_CONTROL_BYTES).identity.sha256 !== output.digest)
                violations.push('Native case output changed during batched resolution inspection.');
        } catch (error) { violations.push(`Native case output recheck rejected: ${String(error)}`); }
    }
    for (const [relative, digest] of sources) {
        try {
            if (validationDigest(readValidationFile(options.repoRoot!, relative, MAX_CONTROL_BYTES).identity) !== digest)
                violations.push('Native case source changed during batched resolution inspection.');
        } catch (error) { violations.push(`Native case source recheck rejected: ${String(error)}`); }
    }
    for (const [relative, digest] of records) {
        try {
            if (readValidationFile(options.repoRoot!, relative, MAX_CONTROL_BYTES).identity.sha256 !== digest)
                violations.push('Native case execution record changed during batched resolution inspection.');
        } catch (error) { violations.push(`Native case execution recheck rejected: ${String(error)}`); }
    }
    return violations;
}
