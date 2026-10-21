import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { assertExistingPathIdentity, bindContainedDestination, writeContainedFile, type ContainedDestination } from './contained-filesystem';
import { readObservedValidationFile, validationDigest, type ValidationFileObservation } from './project-validation-identity';
import { validationPathKey, validationRelativePath } from './validation-relative-path';
import { parseValidationReportFiles, type CapturedValidationReportFile, type ValidationReportCapture,
    type ValidationReportCaptureStart } from './validation-report-contract';

const NANOSECONDS_PER_MILLISECOND = 1_000_000n;
const captures = new WeakMap<ValidationReportCaptureStart, {
    root: string; digest: string; parents: ContainedDestination[];
}>();

function observeIfPresent(root: string, relative: string, maximumBytes: number): ValidationFileObservation | null {
    const binding = bindContainedDestination(root, path.resolve(root, relative));
    if (binding.missingAt) return null;
    const { bytes: _bytes, ...observation } = readObservedValidationFile(root, relative, maximumBytes);
    return observation;
}

export function prepareValidationReportCapture(
    root: string, input: unknown, options: {
        evidenceDirectory: string; excludedPaths?: readonly string[]; excludedRoots?: readonly string[];
    }
): ValidationReportCaptureStart | null {
    const declarations = parseValidationReportFiles(input);
    if (!declarations.length) return null;
    const evidenceDirectory = validationRelativePath(options.evidenceDirectory, 'report evidence directory');
    const excludedRoots = [evidenceDirectory, ...options.excludedRoots ?? []].map(value => validationPathKey(
        validationRelativePath(value, 'excluded report directory')));
    const excluded = new Set((options.excludedPaths ?? []).map(value => validationPathKey(
        validationRelativePath(value, 'excluded report input'))));
    if (declarations.some(item => excluded.has(validationPathKey(item.path))
        || excludedRoots.some(directory => validationPathKey(item.path) === directory
            || validationPathKey(item.path).startsWith(directory + '/'))))
        throw new Error('Validation report paths cannot overwrite observed inputs or owned evidence.');
    const resolvedRoot = path.resolve(root);
    const parents = declarations.map(item => bindContainedDestination(resolvedRoot, path.dirname(path.resolve(resolvedRoot, item.path))));
    const before = declarations.map(item => observeIfPresent(resolvedRoot, item.path, item.max_bytes));
    const anchorPath = `${evidenceDirectory}/report-start-${randomUUID()}.json`;
    if (!bindContainedDestination(resolvedRoot, path.resolve(resolvedRoot, anchorPath)).missingAt)
        throw new Error('Report observation anchor is already owned by another execution.');
    writeContainedFile(resolvedRoot, path.resolve(resolvedRoot, anchorPath), JSON.stringify({
        schema_version: 1, declarations_sha256: validationDigest(declarations), nonce: randomUUID()
    }));
    const anchor = observeIfPresent(resolvedRoot, anchorPath, 4096)!;
    const start: ValidationReportCaptureStart = { schema_version: 1, started_at: new Date().toISOString(), anchor, declarations, before };
    captures.set(start, { root: resolvedRoot, digest: validationDigest(start), parents });
    return start;
}

export function completeValidationReportCapture(root: string, start: ValidationReportCaptureStart | null): ValidationReportCapture | null {
    if (!start) return null;
    try { return captureValidationReportFiles(root, start); }
    catch (error) {
        return { start, completed_at: new Date().toISOString(), reports: [],
            violations: [`Report capture failed: ${error instanceof Error ? error.message : String(error)}`] };
    }
}

export function assertFreshValidationReport(
    observation: ValidationFileObservation, before: ValidationFileObservation | null, started: bigint, completedAt: string
): void {
    const completed = (BigInt(Date.parse(completedAt)) + 1n) * NANOSECONDS_PER_MILLISECOND;
    const modified = BigInt(observation.modified_ns), changed = BigInt(observation.changed_ns);
    const clearInstruction = ` Clear the report directory ${JSON.stringify(path.posix.dirname(observation.identity.path))} before the run.`;
    if (modified <= started || modified >= completed || changed <= started || changed >= completed)
        throw new Error('Declared report was not freshly written within this execution observation.' + clearInstruction);
    if (before?.identity.identity === observation.identity.identity) {
        if (modified <= BigInt(before.modified_ns) || changed <= BigInt(before.changed_ns)
            || before.identity.sha256 === observation.identity.sha256)
            throw new Error('Declared report is stale from an earlier execution.' + clearInstruction);
    } else if (BigInt(observation.created_ns) <= started || BigInt(observation.created_ns) >= completed) {
        // Windows file tunneling can preserve birth time when a builder replaces an existing report.
        if (!before || before.created_ns !== observation.created_ns
            || modified <= BigInt(before.modified_ns) || changed <= BigInt(before.changed_ns))
            throw new Error('Declared report was replaced by a pre-existing foreign file.' + clearInstruction);
    }
}

function bindCurrentReportParent(original: ContainedDestination, started: bigint): ContainedDestination {
    const current = bindContainedDestination(original.root, original.path);
    const completed = (BigInt(Date.now()) + 1n) * NANOSECONDS_PER_MILLISECOND;
    for (const prior of original.existing) {
        const observed = current.existing.find(item => item.path === prior.path);
        if (observed?.dev === prior.dev && observed.ino === prior.ino
            && observed.birthtimeNs === prior.birthtimeNs && observed.mode === prior.mode) continue;
        if (prior.path === original.root || !observed || observed.birthtimeNs <= started || observed.birthtimeNs >= completed)
            throw new Error('Report parent was replaced outside the current execution observation.');
    }
    return current;
}

export function captureValidationReportFiles(root: string, start: ValidationReportCaptureStart): ValidationReportCapture {
    const capture = captures.get(start);
    if (!capture || capture.root !== path.resolve(root) || capture.digest !== validationDigest(start))
        throw new Error('Report capture requires the unchanged same-workspace native start observation.');
    captures.delete(start);
    const anchor = observeIfPresent(capture.root, start.anchor.identity.path, 4096);
    if (validationDigest(anchor) !== validationDigest(start.anchor)) throw new Error('Report observation anchor changed.');
    const started = [anchor!.created_ns, anchor!.modified_ns, anchor!.changed_ns].map(BigInt)
        .reduce((latest, value) => value > latest ? value : latest);
    const reports: CapturedValidationReportFile[] = [], violations: string[] = [];
    for (const [index, declaration] of start.declarations.entries()) {
        try {
            const parent = bindCurrentReportParent(capture.parents[index], started);
            const { bytes, ...observation } = readObservedValidationFile(capture.root, declaration.path, declaration.max_bytes);
            assertExistingPathIdentity(parent);
            assertFreshValidationReport(observation, start.before[index], started, new Date().toISOString());
            reports.push({ observation, content_base64: bytes.toString('base64') });
        } catch (error) {
            violations.push(`Report ${declaration.path}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    if (validationDigest(observeIfPresent(capture.root, start.anchor.identity.path, 4096)) !== validationDigest(start.anchor))
        throw new Error('Report observation anchor changed during capture.');
    return { start, completed_at: new Date().toISOString(), reports, violations };
}
