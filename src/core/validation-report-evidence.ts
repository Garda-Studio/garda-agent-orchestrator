import { isUtf8 } from 'node:buffer';
import { isPlainRecord } from './records';
import { parseFileIdentity, readObservedValidationFile, validationDigest, type ValidationFileObservation } from './project-validation-identity';
import type { ValidationFileIdentity } from './project-validation-contract';
import { validationPathKey, validationRelativePath } from './validation-relative-path';
import { assertFreshValidationReport } from './validation-report-capture';
import { parseValidationReportFiles, type ValidationReportFile, type ValidationReportEvidenceBinding } from './validation-report-contract';

// Ordinary commands retain up to 40 MiB of streams; reports add 16 MiB before base64 and metadata.
export const MAX_RETAINED_VALIDATION_OUTPUT_BYTES = 80 * 1024 * 1024;

export function parseValidationReportEvidenceBinding(value: unknown, expectedDirectory: string): ValidationReportEvidenceBinding {
    const raw = record(value, ['declarations', 'start_sha256', 'evidence_directory'], 'execution binding');
    const declarations = parseValidationReportFiles(raw.declarations);
    if (!declarations.length || typeof raw.start_sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(raw.start_sha256)
        || raw.evidence_directory !== validationRelativePath(expectedDirectory))
        throw new Error('Retained report execution binding is malformed or foreign.');
    return { declarations, start_sha256: raw.start_sha256, evidence_directory: expectedDirectory };
}

function record(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
    if (!isPlainRecord(value) || Object.keys(value).some(key => !keys.includes(key)))
        throw new Error(`Invalid retained report ${label}.`);
    return value;
}

function observation(value: unknown, expectedPath: string, maximumBytes: number): ValidationFileObservation {
    const raw = record(value, ['identity', 'modified_ns', 'changed_ns', 'created_ns'], 'file observation');
    const identity = parseFileIdentity(raw.identity as ValidationFileIdentity, expectedPath);
    if (identity.size > maximumBytes) throw new Error('Retained report exceeds its declared byte bound.');
    for (const key of ['modified_ns', 'changed_ns', 'created_ns']) {
        if (typeof raw[key] !== 'string' || !/^\d{1,30}$/u.test(raw[key] as string))
            throw new Error('Invalid retained report timestamp.');
    }
    if (identity.identity.split(':')[2] !== raw.created_ns) throw new Error('Retained report creation identity disagrees.');
    return { identity, modified_ns: raw.modified_ns as string, changed_ns: raw.changed_ns as string, created_ns: raw.created_ns as string };
}

function timestamp(value: unknown): string {
    if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value)
        throw new Error('Invalid retained report observation time.');
    return value;
}

export function readRetainedValidationReports(options: {
    repoRoot: string; capture: unknown; declarations: unknown; evidenceDirectory: string;
    expectedStartSha256: string | null; executionViolations: readonly string[];
}): { texts: string[]; violations: string[] } {
    const declarations = parseValidationReportFiles(options.declarations);
    if (!declarations.length) {
        if (options.capture !== undefined || options.expectedStartSha256 !== null)
            throw new Error('Execution contains undeclared report evidence.');
        return { texts: [], violations: [] };
    }
    const raw = record(options.capture, ['start', 'completed_at', 'reports', 'violations'], 'capture');
    const start = record(raw.start, ['schema_version', 'started_at', 'anchor', 'declarations', 'before'], 'start');
    if (start.schema_version !== 1 || !options.expectedStartSha256 || validationDigest(start) !== options.expectedStartSha256
        || validationDigest(parseValidationReportFiles(start.declarations)) !== validationDigest(declarations))
        throw new Error('Retained reports disagree with the native execution start or declaration.');
    const startedAt = timestamp(start.started_at), completedAt = timestamp(raw.completed_at);
    if (Date.parse(completedAt) < Date.parse(startedAt)) throw new Error('Retained report observation time is reversed.');
    if (!Array.isArray(start.before) || start.before.length !== declarations.length
        || !Array.isArray(raw.reports) || raw.reports.length > declarations.length
        || !Array.isArray(raw.violations) || raw.violations.length > declarations.length + 1
        || raw.violations.some(value => typeof value !== 'string' || value.length > 16384))
        throw new Error('Retained report capture exceeds its structural bounds.');
    const violations = raw.violations as string[];
    if (violations.some(value => !options.executionViolations.includes(value)))
        throw new Error('Failed report capture is absent from execution violations.');
    const directory = validationRelativePath(options.evidenceDirectory);
    const anchorRaw = record(start.anchor, ['identity', 'modified_ns', 'changed_ns', 'created_ns'], 'anchor');
    const anchorIdentity = record(anchorRaw.identity, ['path', 'sha256', 'size', 'identity'], 'anchor identity');
    const anchorPath = validationRelativePath(anchorIdentity.path);
    const anchorName = anchorPath.slice(directory.length + 1);
    if (!anchorPath.startsWith(directory + '/') || !/^report-start-[a-f0-9-]{36}\.json$/u.test(anchorName))
        throw new Error('Retained report anchor is outside its execution evidence directory.');
    const anchor = observation(anchorRaw, anchorPath, 4096);
    if (!violations.length) {
        const { bytes: _bytes, ...current } = readObservedValidationFile(options.repoRoot, anchorPath, 4096);
        if (validationDigest(observation(current, anchorPath, 4096)) !== validationDigest(anchor))
            throw new Error('Retained report start anchor changed.');
    }
    const cutoff = [anchor.created_ns, anchor.modified_ns, anchor.changed_ns].map(BigInt)
        .reduce((latest, value) => value > latest ? value : latest);
    const before = start.before.map((item, index) => item === null ? null
        : observation(item, declarations[index].path, declarations[index].max_bytes));
    const seen = new Set<string>();
    const texts = raw.reports.map(item => {
        const retained = record(item, ['observation', 'content_base64'], 'bytes');
        const observedRaw = record(retained.observation, ['identity', 'modified_ns', 'changed_ns', 'created_ns'], 'observation');
        const identity = record(observedRaw.identity, ['path', 'sha256', 'size', 'identity'], 'identity');
        const index = declarations.findIndex(candidate => candidate.path === identity.path);
        if (index < 0 || seen.has(validationPathKey(declarations[index].path)))
            throw new Error('Retained report is foreign or duplicated.');
        const declaration: ValidationReportFile = declarations[index];
        seen.add(validationPathKey(declaration.path));
        const observed = observation(observedRaw, declaration.path, declaration.max_bytes);
        assertFreshValidationReport(observed, before[index], cutoff, completedAt);
        if (typeof retained.content_base64 !== 'string'
            || retained.content_base64.length > Math.ceil(declaration.max_bytes / 3) * 4)
            throw new Error('Retained report encoding exceeds its declared bound.');
        const bytes = Buffer.from(retained.content_base64, 'base64');
        if (bytes.toString('base64') !== retained.content_base64 || bytes.length !== observed.identity.size
            || validationDigest(bytes) !== observed.identity.sha256) throw new Error('Retained report bytes changed.');
        const utf8 = isUtf8(bytes);
        return `[report ${JSON.stringify(declaration.path)}; encoding=${utf8 ? 'utf8' : 'base64'}]\n`
            + (utf8 ? bytes.toString('utf8') : retained.content_base64);
    });
    if (!violations.length && seen.size !== declarations.length) throw new Error('A required retained report is missing.');
    return { texts, violations };
}
