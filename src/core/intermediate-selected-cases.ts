import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ValidationFileIdentity } from './project-validation-contract';
import { readValidationFile, validationDigest } from './project-validation-identity';
import { isPlainRecord } from './records';
import { inspectValidationCommand, type ValidationCommandDescriptor } from './validation-command-contract';

const MAX_SOURCES = 128, MAX_SOURCE_BYTES = 8 * 1024 * 1024;
export interface SelectedCaseClaim { source: string; case_id: string; selector: string }
export interface IntermediateSelection {
    schema_version: 1;
    sources: ValidationFileIdentity[];
    cases: SelectedCaseClaim[];
    unobserved_operands?: string[];
}
export interface IntermediateSelectionBinding {
    before: IntermediateSelection;
    after: Array<ValidationFileIdentity | null> | null;
    observation_error?: string;
}
export function intermediateInvocationIdentity(command: unknown): string | null {
    if (typeof command !== 'string') return null;
    const descriptor = inspectValidationCommand(command, 'validation').descriptor;
    return descriptor ? validationDigest(descriptor.invocations) : null;
}
const pathKey = (value: string): string => process.platform === 'win32' ? value.toLowerCase() : value;
function relativeSource(root: string, value: string): string {
    const relative = path.relative(path.resolve(root), path.resolve(root, value)).replace(/\\/gu, '/');
    if (!relative || relative === '..' || relative.startsWith('../') || path.isAbsolute(relative))
        throw new Error('Selected source must be a contained repository file.');
    return relative;
}
function boundedText(value: unknown): value is string {
    return typeof value === 'string' && !!value.trim() && value.length <= 4096 && !/[\0\r\n]/u.test(value);
}

/** Literal operands and explicit symbolic claims share one relation; neither proves case semantics. */
export function captureIntermediateSelection(root: string, descriptor: ValidationCommandDescriptor,
    input?: unknown): IntermediateSelection {
    const tokens = descriptor.invocations.flatMap(item => [item.executable, ...item.argv]);
    const values = tokens.flatMap(token => [token, ...(token.includes('=') ? [token.slice(token.indexOf('=') + 1)] : [])]);
    if (input !== undefined && !Array.isArray(input)) throw new Error('Selected cases must be an array.');
    if (Array.isArray(input) && input.length > MAX_SOURCES) throw new Error('Selected cases exceed their bound.');
    const cases: SelectedCaseClaim[] = (Array.isArray(input) ? input : []).map((item: unknown) => {
        const claim: unknown = typeof item === 'string' ? JSON.parse(item) : item;
        if (!isPlainRecord(claim) || Object.keys(claim).some(key => !['source', 'case_id', 'selector'].includes(key))
            || !boundedText(claim.source) || !boundedText(claim.case_id) || !boundedText(claim.selector))
            throw new Error('Selected case requires a bounded source, case_id and literal selector.');
        if (!values.includes(claim.selector)) throw new Error('Selected case selector is absent from the actual literal command.');
        return { source: relativeSource(root, claim.source), case_id: claim.case_id, selector: claim.selector };
    });
    const sources = new Map<string, ValidationFileIdentity>();
    const unobserved: string[] = [];
    const add = (relative: string): void => {
        if (sources.has(pathKey(relative))) return;
        if (sources.size >= MAX_SOURCES) throw new Error('Selected source inputs exceed their bound.');
        sources.set(pathKey(relative), readValidationFile(root, relative, MAX_SOURCE_BYTES).identity);
    };
    for (const claim of cases) add(claim.source);
    for (const value of values) {
        if (!value || value.startsWith('-')) continue;
        let relative: string;
        try { relative = relativeSource(root, value); } catch { continue; }
        if (!fs.existsSync(path.resolve(root, relative))) continue;
        // Directories are scope operands, not source identities. Existing file operands fail closed.
        if (fs.lstatSync(path.resolve(root, relative)).isDirectory()) continue;
        try { add(relative); } catch {
            // An automatic file operand can be generated output. Missing identity never authorizes it as a selected source.
            if (unobserved.length < MAX_SOURCES) unobserved.push(relative);
        }
    }
    if (new Set(cases.map(item => validationDigest([pathKey(item.source), item.case_id]))).size !== cases.length)
        throw new Error('Selected case source identities are ambiguous.');
    return { schema_version: 1, sources: [...sources.values()], cases,
        ...(unobserved.length ? { unobserved_operands: unobserved } : {}) };
}

export function completeIntermediateSelection(root: string, before: IntermediateSelection): IntermediateSelectionBinding {
    const after = before.sources.map(source => {
        try { return readValidationFile(root, source.path, MAX_SOURCE_BYTES).identity; } catch { return null; }
    });
    return { before, after, ...(after.includes(null) ? { observation_error: 'Some file operand identities are unavailable after execution.' } : {}) };
}

function isFileIdentity(item: unknown): item is ValidationFileIdentity {
    return isPlainRecord(item) && boundedText(item.path)
        && typeof item.sha256 === 'string' && /^[a-f0-9]{64}$/u.test(item.sha256)
        && Number.isSafeInteger(item.size) && Number(item.size) >= 0 && boundedText(item.identity);
}

export function isIntermediateSelection(value: unknown): value is IntermediateSelection {
    if (!isPlainRecord(value) || value.schema_version !== 1 || !Array.isArray(value.sources)
        || !Array.isArray(value.cases) || value.sources.length > MAX_SOURCES || value.cases.length > MAX_SOURCES) return false;
    return (value.unobserved_operands === undefined || Array.isArray(value.unobserved_operands)
        && value.unobserved_operands.length <= MAX_SOURCES && value.unobserved_operands.every(boundedText))
        && value.sources.every(isFileIdentity)
        && value.cases.every(item => isPlainRecord(item) && boundedText(item.source)
            && boundedText(item.case_id) && boundedText(item.selector));
}
export function selectionMatchesCase(selection: IntermediateSelection, sourcePath: string, caseId: string): boolean {
    if (!selection.sources.some(source => pathKey(source.path) === pathKey(sourcePath))) return false;
    const cases = selection.cases.filter(item => pathKey(item.source) === pathKey(sourcePath));
    return cases.length === 0 || cases.some(item => item.case_id === caseId);
}
/** Empty sourcePaths validates observed facts only; case consumers must request their actual source identities. */
export function assertCurrentIntermediateSelection(root: string, value: unknown,
    sourcePaths?: readonly string[]): asserts value is IntermediateSelectionBinding {
    if (!isPlainRecord(value) || !isIntermediateSelection(value.before) || !Array.isArray(value.after))
        throw new Error('Selected command source identity facts are malformed.');
    const before = value.before, after = value.after;
    if (after.length !== before.sources.length || !after.every((item, index) => item === null || isFileIdentity(item)
        && pathKey(item.path) === pathKey(before.sources[index].path)))
        throw new Error('Selected command source identity facts are malformed.');
    const requested = new Set((sourcePaths ?? before.sources.map(source => source.path)).map(pathKey));
    if ([...requested].some(file => !before.sources.some(source => pathKey(source.path) === file)))
        throw new Error('Selected command source identity was not captured before execution.');
    for (const [index, source] of before.sources.entries()) {
        if (!requested.has(pathKey(source.path))) continue;
        if (validationDigest(source) !== validationDigest(after[index]))
            throw new Error('Selected command source identities changed during execution.');
        if (validationDigest(readValidationFile(root, source.path, MAX_SOURCE_BYTES).identity) !== validationDigest(source))
            throw new Error('Selected command source identity is no longer current.');
    }
}
