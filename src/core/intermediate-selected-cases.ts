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
    scope_operands?: string[];
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
export const intermediateSourcePathKey = (value: string): string => process.platform === 'win32' ? value.toLowerCase() : value;
function relativeSource(root: string, value: string): string {
    const relative = path.relative(path.resolve(root), path.resolve(root, value)).replace(/\\/gu, '/');
    if (!relative || relative === '..' || relative.startsWith('../') || path.isAbsolute(relative))
        throw new Error('Selected source must be a contained repository file.');
    return relative;
}
function boundedText(value: unknown): value is string {
    return typeof value === 'string' && !!value.trim() && value.length <= 4096 && !/[\0\r\n]/u.test(value);
}

// Name the exact token that would satisfy the literal relation, for example a whole dotnet
// `FullyQualifiedName~X` filter or a Maven `-Dtest=Class#method` value, without loosening it.
function describeAbsentSelector(selector: string, values: readonly string[]): string {
    const containing = [...new Set(values.filter(value => value !== selector && value.includes(selector)))]
        .sort((left, right) => left.length - right.length).slice(0, 3).map(value => JSON.stringify(value.length > 160 ? `${value.slice(0, 157)}...` : value));
    return 'Selected case selector is absent from the actual literal command. The selector must equal one whole '
        + 'command token or the text after "=" in a token. '
        + (containing.length > 0
            ? `Use the full token instead: ${containing.join(' or ')}.`
            : 'Put the selector into --command exactly as the selector value.');
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
        if (!values.includes(claim.selector)) throw new Error(describeAbsentSelector(claim.selector, values));
        return { source: relativeSource(root, claim.source), case_id: claim.case_id, selector: claim.selector };
    });
    const sources = new Map<string, ValidationFileIdentity>();
    const scopes = new Set<string>();
    const unobserved: string[] = [];
    const add = (relative: string): void => {
        if (sources.has(intermediateSourcePathKey(relative))) return;
        if (sources.size >= MAX_SOURCES) throw new Error('Selected source inputs exceed their bound.');
        sources.set(intermediateSourcePathKey(relative), readValidationFile(root, relative, MAX_SOURCE_BYTES).identity);
    };
    for (const claim of cases) add(claim.source);
    for (const value of values) {
        if (!value || value.startsWith('-')) continue;
        let relative: string;
        try { relative = relativeSource(root, value); } catch {
            if (path.resolve(root, value) === path.resolve(root)) {
                if (!scopes.has('.') && scopes.size >= MAX_SOURCES) throw new Error('Directory scope operands exceed their bound.');
                scopes.add('.');
            }
            continue;
        }
        if (!fs.existsSync(path.resolve(root, relative))) continue;
        // Directory scope must remain observable even though it is not a source-file identity.
        if (fs.statSync(path.resolve(root, relative)).isDirectory()) {
            if (scopes.size >= MAX_SOURCES) throw new Error('Directory scope operands exceed their bound.');
            scopes.add(relative);
            continue;
        }
        try { add(relative); } catch {
            // An automatic file operand can be generated output. Missing identity never authorizes it as a selected source.
            if (unobserved.length < MAX_SOURCES) unobserved.push(relative);
        }
    }
    if (new Set(cases.map(item => validationDigest([intermediateSourcePathKey(item.source), item.case_id]))).size !== cases.length)
        throw new Error('Selected case source identities are ambiguous.');
    return { schema_version: 1, sources: [...sources.values()], cases, scope_operands: [...scopes],
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
    return (value.scope_operands === undefined || Array.isArray(value.scope_operands)
        && value.scope_operands.length <= MAX_SOURCES && value.scope_operands.every(boundedText))
        && (value.unobserved_operands === undefined || Array.isArray(value.unobserved_operands)
        && value.unobserved_operands.length <= MAX_SOURCES && value.unobserved_operands.every(boundedText))
        && value.sources.every(isFileIdentity)
        && value.cases.every(item => isPlainRecord(item) && boundedText(item.source)
            && boundedText(item.case_id) && boundedText(item.selector));
}
export function selectionMatchesCase(selection: IntermediateSelection, sourcePath: string, caseId?: string): boolean {
    if (!selection.sources.some(source => intermediateSourcePathKey(source.path) === intermediateSourcePathKey(sourcePath))) return false;
    const cases = selection.cases.filter(item => intermediateSourcePathKey(item.source) === intermediateSourcePathKey(sourcePath));
    return caseId === undefined || cases.length === 0 || cases.some(item => item.case_id === caseId);
}

/** Selects facts from an already authenticated current-cycle timeline; it grants no execution or semantic authority. */
export function latestMatchingIntermediateAttempt<T extends Record<string, unknown>>(
    attempts: readonly T[], sourcePath: string, caseId?: string
): T | undefined {
    const details = (event: T) => isPlainRecord(event.details) ? event.details : {};
    const sequence = (event: T) => isPlainRecord(event.integrity) ? Number(event.integrity.task_sequence) : NaN;
    const selection = (event: T) => {
        const value = details(event), binding = value.selected_case_binding;
        return value.selected_case_selection ?? (isPlainRecord(binding) ? binding.before : undefined);
    };
    const identities = new Map(attempts.map(event => [event, intermediateInvocationIdentity(details(event).command)]));
    const starts = new Map<string, T>();
    for (const event of attempts) if (event.event_type === 'INTERMEDIATE_COMMAND_STARTED') {
        const id = details(event).execution_id;
        if (typeof id !== 'string' || starts.has(id) || !Number.isSafeInteger(sequence(event)))
            throw new Error('Native command start identity is missing or ambiguous.');
        starts.set(id, event);
    }
    const startSequence = (event: T) => sequence(starts.get(String(details(event).execution_id)) ?? event);
    const ordered = [...attempts].sort((left, right) => startSequence(right) - startSequence(left)
        || sequence(right) - sequence(left));
    const associated = new Set(attempts.filter(event => {
        const value = selection(event);
        return isIntermediateSelection(value) && selectionMatchesCase(value, sourcePath, caseId);
    }).map(event => identities.get(event)).filter(identity => identity != null));
    return ordered.find(event => {
        const value = selection(event), identity = identities.get(event);
        return identity != null && associated.has(identity) || value === undefined
            || !isIntermediateSelection(value) || selectionMatchesCase(value, sourcePath, caseId);
    });
}
/** Empty sourcePaths validates observed facts only; case consumers must request their actual source identities. */
export function assertCurrentIntermediateSelection(root: string, value: unknown,
    sourcePaths?: readonly string[]): asserts value is IntermediateSelectionBinding {
    if (!isPlainRecord(value) || !isIntermediateSelection(value.before) || !Array.isArray(value.after))
        throw new Error('Selected command source identity facts are malformed.');
    const before = value.before, after = value.after;
    if (after.length !== before.sources.length || !after.every((item, index) => item === null || isFileIdentity(item)
        && intermediateSourcePathKey(item.path) === intermediateSourcePathKey(before.sources[index].path)))
        throw new Error('Selected command source identity facts are malformed.');
    const requested = new Set((sourcePaths ?? before.sources.map(source => source.path)).map(intermediateSourcePathKey));
    if ([...requested].some(file => !before.sources.some(source => intermediateSourcePathKey(source.path) === file)))
        throw new Error('Selected command source identity was not captured before execution.');
    for (const [index, source] of before.sources.entries()) {
        if (!requested.has(intermediateSourcePathKey(source.path))) continue;
        if (validationDigest(source) !== validationDigest(after[index]))
            throw new Error('Selected command source identities changed during execution.');
        if (validationDigest(readValidationFile(root, source.path, MAX_SOURCE_BYTES).identity) !== validationDigest(source))
            throw new Error(`Selected command source identity is no longer current: ${source.path}.`);
    }
}
