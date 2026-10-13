import type { ValidationFileIdentity } from './project-validation-contract';
import type { TrustBoundarySourceEvidence } from './trust-boundary-analysis';

export const MAX_BOUNDARY_SOURCE_REFERENCES = 128;
export const MAX_BOUNDARY_SOURCE_BYTES = 8 * 1024 * 1024;

export interface BoundarySourceReference { filePath: string; caseId: string }

function retainedSources(expected: readonly ValidationFileIdentity[] | undefined,
    paths: readonly string[], violations: string[]): Map<string, ValidationFileIdentity> | null {
    if (expected === undefined) return null;
    const sources = new Map<string, ValidationFileIdentity>();
    if (!Array.isArray(expected) || expected.length > MAX_BOUNDARY_SOURCE_REFERENCES) {
        violations.push('Retained boundary source identities must be a bounded array.');
        return sources;
    }
    for (const identity of expected) {
        if (!identity || typeof identity.path !== 'string' || sources.has(identity.path)) {
            violations.push('Retained boundary source identities are missing or ambiguous.');
        } else {
            sources.set(identity.path, identity);
        }
    }
    if (sources.size !== paths.length || paths.some(file => !sources.has(file))) {
        violations.push('Retained boundary source identities must cover the exact source set.');
    }
    return sources;
}

function sameSource(actual: ValidationFileIdentity, expected: ValidationFileIdentity): boolean {
    return actual.path === expected.path && actual.sha256 === expected.sha256
        && actual.size === expected.size && actual.identity === expected.identity;
}

function captureSources(root: string, paths: readonly string[],
    expected: Map<string, ValidationFileIdentity> | null, violations: string[]) {
    const { readValidationFile } = require('./project-validation-identity') as typeof import('./project-validation-identity');
    const sources = new Map<string, ValidationFileIdentity>();
    let remainingBytes = MAX_BOUNDARY_SOURCE_BYTES;
    for (const file of paths) {
        try {
            const { identity } = readValidationFile(root, file, remainingBytes);
            remainingBytes -= identity.size;
            if (expected && (!expected.has(file) || !sameSource(identity, expected.get(file)!))) {
                throw new Error('Retained source identity changed');
            }
            sources.set(file, identity);
        } catch (error) {
            violations.push(`Boundary source rejected (${file}): ${String(error)}`);
        }
    }
    return sources;
}

function revalidateSources(root: string, sources: Map<string, ValidationFileIdentity>, violations: string[]) {
    const { readValidationFile } = require('./project-validation-identity') as typeof import('./project-validation-identity');
    for (const [file, expected] of sources) {
        try {
            if (!sameSource(readValidationFile(root, file, expected.size).identity, expected)) {
                throw new Error('Boundary source identity changed during capture');
            }
        } catch (error) {
            sources.delete(file);
            violations.push(`Boundary source changed (${file}): ${String(error)}`);
        }
    }
}

export function readBoundarySourceEvidence(options: {
    repoRoot: string; references: readonly BoundarySourceReference[];
    expectedSources?: readonly ValidationFileIdentity[];
}): { sourceEvidence: TrustBoundarySourceEvidence[]; violations: string[] } {
    const violations: string[] = [];
    if (options.references.length > MAX_BOUNDARY_SOURCE_REFERENCES) {
        return { sourceEvidence: [], violations: ['Boundary evidence exceeds the reference bound.'] };
    }
    const paths = [...new Set(options.references.map(reference => reference.filePath))];
    const expected = retainedSources(options.expectedSources, paths, violations);
    const sources = captureSources(options.repoRoot, paths, expected, violations);
    revalidateSources(options.repoRoot, sources, violations);
    const sourceEvidence = options.references.flatMap(reference => {
        const identity = sources.get(reference.filePath);
        return identity ? [{ source_identity: { ...identity }, case_id: reference.caseId,
            selector: reference.caseId, syntax_status: 'UNRESOLVED' as const }] : [];
    });
    return { sourceEvidence, violations };
}
