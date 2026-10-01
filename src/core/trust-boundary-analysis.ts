import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { maskTestEvidenceRegexLiterals } from './test-evidence-lexing';

export const TRUST_BOUNDARY_ANALYSIS_RULE_ID = 'trust_boundary_adversarial_analysis';
export const TRUST_BOUNDARY_ANALYSIS_RULE_TITLE = 'Trust-boundary and adversarial-path analysis';
export const TRUST_BOUNDARY_ANALYSIS_RULE_PROMPT =
    'For security, authorization, protected-control-plane, recovery, evidence, or artifact-trust changes, provide a compact trust_boundary_matrix. Name every trust boundary and record its authority source, mutable inputs, immutable or integrity-bound evidence, canonical reconstruction, TOCTOU or replay behavior, and targeted negative paths with test evidence. Every negative-path evidence_files entry must use path#exact test name, scenario must equal that declared test name, and the named test callback must contain a direct assertion statement outside conditional control flow or a nested callback. Happy-path evidence alone is not sufficient.';

export const TRUST_BOUNDARY_NEGATIVE_PATH_KINDS = Object.freeze([
    'forged',
    'replaced',
    'missing',
    'foreign',
    'stale',
    'other'
] as const);

export type TrustBoundaryNegativePathKind = typeof TRUST_BOUNDARY_NEGATIVE_PATH_KINDS[number];

const ADVERSARIAL_SCENARIO_PATTERN =
    /\b(?:adversarial|invalid|malformed|forged|replaced|missing|foreign|stale|tamper(?:ed|ing)?|unauthori[sz]ed|denied|rejected|outside|escape|traversal|symlink|replay|toctou|race|duplicate|mismatch|untrusted|corrupt(?:ed|ion)?|fail(?:s|ed|ure)?|reject(?:s|ed)?|block(?:s|ed)?|prevent(?:s|ed)?)\b/i;
const FAIL_CLOSED_BEHAVIOR_PATTERN =
    /\b(?:reject(?:s|ed)?|fail(?:s|ed|ure)?(?:[-\s]?closed)?|block(?:s|ed)?|deny|denies|denied|prevent(?:s|ed)?|refuse(?:s|d)?|preserve(?:s|d)?|recover(?:s|ed|y)?|retry|restart|stop(?:s|ped)?|ignore(?:s|d)?|quarantine(?:s|d)?|invalidate(?:s|d)?|error)\b/i;

export const TRUST_BOUNDARY_SENSITIVE_CHANGED_FILE_REGEXES = Object.freeze([
    '(^|/)(?:src|bin|scripts|config|template)/.*(?:auth|authori[sz]ation|permission|access|security|protected|recovery|evidence|artifact|trust|integrity|receipt|provenance|review(?:er)?-(?:context|finding|result|receipt|routing|launch|invocation|output|cycle|trust|evidence|identity|attestation)|required-review|completion|task-audit|task-mode|operator-confirmation|hash|signature|token|secret).*(?:\\.(?:ts|tsx|js|mjs|cjs|json|ya?ml|md)|$)',
    '(^|/)(?:AGENTS\\.md|template/docs/agent-rules/(?:00-core|70-security|80-task-workflow)\\.md)$',
    '(^|/)(?:garda-agent-orchestrator/(?:live|template)|template)/config/workflow-config\\.json$'
] as const);

export interface TrustBoundaryNegativePath {
    kind: TrustBoundaryNegativePathKind;
    scenario: string;
    expected_behavior: string;
    evidence_files: string[];
}

export interface TrustBoundaryMatrixEntry {
    boundary_id: string;
    boundary: string;
    authority_source: string;
    mutable_inputs: string[];
    integrity_evidence: string[];
    canonical_reconstruction: string;
    toctou_replay: string;
    negative_paths: TrustBoundaryNegativePath[];
}

export interface TrustBoundaryMatrixAssessment {
    matrix: TrustBoundaryMatrixEntry[];
    matrix_sha256: string;
    violations: string[];
}

export interface TrustBoundaryAnalysisApplicability {
    required: boolean;
    reasons: string[];
}

export interface TrustBoundaryMatrixAssessmentOptions {
    repoRoot?: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeText(value: unknown): string {
    return String(value || '').trim();
}

function normalizeTextArray(value: unknown): string[] {
    if (!Array.isArray(value)) {
        return [];
    }
    return [...new Set(value.map(normalizeText).filter(Boolean))];
}

function normalizeChangedFile(value: unknown): string {
    return normalizeText(value).replace(/\\/g, '/');
}

function normalizeTestEvidenceReference(value: unknown): string {
    const normalized = normalizeText(value);
    const separatorIndex = normalized.indexOf('#');
    if (separatorIndex < 0) {
        return normalizeChangedFile(normalized);
    }
    const evidenceFile = normalizeChangedFile(normalized.slice(0, separatorIndex));
    const testName = normalizeText(normalized.slice(separatorIndex + 1));
    return `${evidenceFile}#${testName}`;
}

function parseTestEvidenceReference(value: string): { evidenceFile: string; testName: string } | null {
    const separatorIndex = value.indexOf('#');
    if (separatorIndex <= 0 || separatorIndex === value.length - 1) {
        return null;
    }
    return {
        evidenceFile: value.slice(0, separatorIndex),
        testName: value.slice(separatorIndex + 1)
    };
}

function declaresAssertiveNamedTestCase(sourceText: string, testName: string, evidenceFile: string): boolean {
    const source = maskTestEvidenceRegexLiterals(sourceText, evidenceFile);
    if (source === null) return false;
    type LexicalMode = 'code' | 'line_comment' | 'block_comment' | 'single_quote' | 'double_quote' | 'template';
    let mode: LexicalMode = 'code';
    let escaped = false;
    let lineLeading = true;
    const declarationBlockStack: boolean[] = [];
    const callStack: Array<string | null> = [];
    let pendingArrowCallbackBody = false;
    let pendingFunctionCallbackBody = false;

    const readCallNameBeforeParenthesis = (openParenthesisIndex: number): string | null => {
        let cursor = openParenthesisIndex - 1;
        while (/\s/u.test(source[cursor] || '')) cursor -= 1;
        const segments: string[] = [];
        while (cursor >= 0) {
            const segmentEnd = cursor + 1;
            while (/[\w$]/u.test(source[cursor] || '')) cursor -= 1;
            if (segmentEnd === cursor + 1) break;
            segments.unshift(source.slice(cursor + 1, segmentEnd));
            while (/\s/u.test(source[cursor] || '')) cursor -= 1;
            if (source[cursor] !== '.') break;
            cursor -= 1;
            while (/\s/u.test(source[cursor] || '')) cursor -= 1;
        }
        return segments.length > 0 ? segments.join('.') : null;
    };

    const isEnabledSuiteCall = (callName: string | null): boolean => (
        callName === 'describe'
        || callName === 'describe.only'
        || callName === 'suite'
        || callName === 'suite.only'
        || callName === 'context'
        || callName === 'context.only'
    );

    const hasAssertionSignal = (startIndex: number, endIndex: number): boolean => {
        let assertionMode: LexicalMode = 'code';
        let assertionEscaped = false;
        const unsafeBlockStack: boolean[] = [];
        let parenthesisDepth = 0;
        let bracketDepth = 0;
        let statementStart = true;
        let awaitPrefix = false;
        let terminated = false;
        let pendingUnsafeBlock = false;
        for (let cursor = startIndex; cursor < endIndex; cursor += 1) {
            const character = source[cursor];
            const nextCharacter = source[cursor + 1];
            if (assertionMode === 'line_comment') {
                if (character === '\n') assertionMode = 'code';
                continue;
            }
            if (assertionMode === 'block_comment') {
                if (character === '*' && nextCharacter === '/') {
                    assertionMode = 'code';
                    cursor += 1;
                }
                continue;
            }
            if (assertionMode !== 'code') {
                if (assertionEscaped) {
                    assertionEscaped = false;
                    continue;
                }
                if (character === '\\') {
                    assertionEscaped = true;
                    continue;
                }
                if (assertionMode === 'template') {
                    if (character === '`') assertionMode = 'code';
                    continue;
                }
                if ((assertionMode === 'single_quote' && character === "'")
                    || (assertionMode === 'double_quote' && character === '"')) {
                    assertionMode = 'code';
                }
                continue;
            }
            if (character === '/' && nextCharacter === '/') {
                assertionMode = 'line_comment';
                cursor += 1;
                continue;
            }
            if (character === '/' && nextCharacter === '*') {
                assertionMode = 'block_comment';
                cursor += 1;
                continue;
            }
            if (character === "'" || character === '"' || character === '`') {
                assertionMode = character === "'"
                    ? 'single_quote'
                    : character === '"' ? 'double_quote' : 'template';
                continue;
            }
            if (character === '{') {
                unsafeBlockStack.push(pendingUnsafeBlock);
                pendingUnsafeBlock = false;
                statementStart = true;
                awaitPrefix = false;
                continue;
            }
            if (character === '}') {
                unsafeBlockStack.pop();
                statementStart = true;
                awaitPrefix = false;
                continue;
            }
            if (character === '(') {
                parenthesisDepth += 1;
                continue;
            }
            if (character === ')') {
                parenthesisDepth = Math.max(0, parenthesisDepth - 1);
                continue;
            }
            if (character === '[') {
                bracketDepth += 1;
                continue;
            }
            if (character === ']') {
                bracketDepth = Math.max(0, bracketDepth - 1);
                continue;
            }
            const inUnsafeBlock = unsafeBlockStack.includes(true);
            const atStatementLevel = parenthesisDepth === 0 && bracketDepth === 0;
            if (character === '=' && nextCharacter === '>') {
                pendingUnsafeBlock = true;
                statementStart = false;
                cursor += 1;
                continue;
            }
            if (atStatementLevel && character === ';') {
                statementStart = true;
                awaitPrefix = false;
                pendingUnsafeBlock = false;
                continue;
            }
            if (!/[A-Za-z_$]/u.test(character)) continue;
            let identifierEnd = cursor + 1;
            while (/[\w$]/u.test(source[identifierEnd] || '')) identifierEnd += 1;
            const identifier = source.slice(cursor, identifierEnd);
            if (!atStatementLevel) {
                cursor = identifierEnd - 1;
                continue;
            }
            if (identifier === 'if' || identifier === 'for' || identifier === 'while'
                || identifier === 'switch' || identifier === 'catch' || identifier === 'else'
                || identifier === 'function' || identifier === 'do') {
                pendingUnsafeBlock = true;
            }
            if (!inUnsafeBlock && statementStart && (identifier === 'return' || identifier === 'throw')) {
                terminated = true;
                statementStart = false;
                cursor = identifierEnd - 1;
                continue;
            }
            if (!inUnsafeBlock && statementStart && identifier === 'await') {
                awaitPrefix = true;
                statementStart = false;
                cursor = identifierEnd - 1;
                continue;
            }
            const isDirectAssertion = !terminated
                && !inUnsafeBlock
                && (statementStart || awaitPrefix)
                && (identifier === 'assert' || identifier === 'expect' || identifier === 'should');
            if (isDirectAssertion) {
                let signalCursor = identifierEnd;
                while (/\s/u.test(source[signalCursor] || '')) signalCursor += 1;
                if (source[signalCursor] === '(' || source[signalCursor] === '.') return true;
            }
            statementStart = false;
            awaitPrefix = false;
            cursor = identifierEnd - 1;
        }
        return false;
    };

    const findMatchingBrace = (openBraceIndex: number): number | null => {
        let braceDepth = 1;
        let braceMode: LexicalMode = 'code';
        let braceEscaped = false;
        for (let cursor = openBraceIndex + 1; cursor < source.length; cursor += 1) {
            const character = source[cursor];
            const nextCharacter = source[cursor + 1];
            if (braceMode === 'line_comment') {
                if (character === '\n') braceMode = 'code';
                continue;
            }
            if (braceMode === 'block_comment') {
                if (character === '*' && nextCharacter === '/') {
                    braceMode = 'code';
                    cursor += 1;
                }
                continue;
            }
            if (braceMode !== 'code') {
                if (braceEscaped) {
                    braceEscaped = false;
                    continue;
                }
                if (character === '\\') {
                    braceEscaped = true;
                    continue;
                }
                if (braceMode === 'template') {
                    if (character === '`') braceMode = 'code';
                    continue;
                }
                if ((braceMode === 'single_quote' && character === "'")
                    || (braceMode === 'double_quote' && character === '"')) {
                    braceMode = 'code';
                }
                continue;
            }
            if (character === '/' && nextCharacter === '/') {
                braceMode = 'line_comment';
                cursor += 1;
                continue;
            }
            if (character === '/' && nextCharacter === '*') {
                braceMode = 'block_comment';
                cursor += 1;
                continue;
            }
            if (character === "'" || character === '"' || character === '`') {
                braceMode = character === "'" ? 'single_quote' : character === '"' ? 'double_quote' : 'template';
                continue;
            }
            if (character === '{') braceDepth += 1;
            if (character === '}') {
                braceDepth -= 1;
                if (braceDepth === 0) return cursor;
            }
        }
        return null;
    };

    const readDirectTestDeclaration = (startIndex: number): { name: string; assertive: boolean } | null => {
        const identifier = source.startsWith('test', startIndex) ? 'test' : source.startsWith('it', startIndex) ? 'it' : null;
        if (!identifier) return null;
        const identifierEnd = startIndex + identifier.length;
        if (/[\w$]/u.test(source[identifierEnd] || '')) return null;
        let cursor = identifierEnd;
        while (source[cursor] === ' ' || source[cursor] === '\t') cursor += 1;
        if (source[cursor] !== '(') return null;
        cursor += 1;
        while (source[cursor] === ' ' || source[cursor] === '\t') cursor += 1;
        const quote = source[cursor];
        if (quote !== "'" && quote !== '"') return null;
        cursor += 1;
        const nameStart = cursor;
        while (cursor < source.length && source[cursor] !== quote) {
            if (source[cursor] === '\\' || source[cursor] === '\n' || source[cursor] === '\r') return null;
            cursor += 1;
        }
        if (source[cursor] !== quote) return null;
        const declaredName = source.slice(nameStart, cursor);
        cursor += 1;
        while (source[cursor] === ' ' || source[cursor] === '\t') cursor += 1;
        if (source[cursor] !== ',') return null;
        cursor += 1;

        let callParenthesisDepth = 1;
        let nestedBraceDepth = 0;
        let nestedBracketDepth = 0;
        let declarationMode: LexicalMode = 'code';
        let declarationEscaped = false;
        let functionCandidate = false;
        for (; cursor < source.length; cursor += 1) {
            const character = source[cursor];
            const nextCharacter = source[cursor + 1];
            if (declarationMode === 'line_comment') {
                if (character === '\n') declarationMode = 'code';
                continue;
            }
            if (declarationMode === 'block_comment') {
                if (character === '*' && nextCharacter === '/') {
                    declarationMode = 'code';
                    cursor += 1;
                }
                continue;
            }
            if (declarationMode !== 'code') {
                if (declarationEscaped) {
                    declarationEscaped = false;
                    continue;
                }
                if (character === '\\') {
                    declarationEscaped = true;
                    continue;
                }
                if (declarationMode === 'template') {
                    if (character === '`') declarationMode = 'code';
                    continue;
                }
                if ((declarationMode === 'single_quote' && character === "'")
                    || (declarationMode === 'double_quote' && character === '"')) {
                    declarationMode = 'code';
                }
                continue;
            }
            if (character === '/' && nextCharacter === '/') {
                declarationMode = 'line_comment';
                cursor += 1;
                continue;
            }
            if (character === '/' && nextCharacter === '*') {
                declarationMode = 'block_comment';
                cursor += 1;
                continue;
            }
            if (character === "'" || character === '"' || character === '`') {
                declarationMode = character === "'"
                    ? 'single_quote'
                    : character === '"' ? 'double_quote' : 'template';
                continue;
            }
            if (character === '(') callParenthesisDepth += 1;
            if (character === ')') {
                callParenthesisDepth -= 1;
                if (callParenthesisDepth === 0) return { name: declaredName, assertive: false };
            }
            if (character === '[') nestedBracketDepth += 1;
            if (character === ']') nestedBracketDepth = Math.max(0, nestedBracketDepth - 1);
            if (character === '{') {
                if (functionCandidate && callParenthesisDepth === 1 && nestedBraceDepth === 0 && nestedBracketDepth === 0) {
                    const bodyEnd = findMatchingBrace(cursor);
                    return {
                        name: declaredName,
                        assertive: bodyEnd !== null && hasAssertionSignal(cursor + 1, bodyEnd)
                    };
                }
                nestedBraceDepth += 1;
            }
            if (character === '}') nestedBraceDepth = Math.max(0, nestedBraceDepth - 1);
            const atCallbackArgumentLevel = callParenthesisDepth === 1
                && nestedBraceDepth === 0
                && nestedBracketDepth === 0;
            if (atCallbackArgumentLevel && source.startsWith('function', cursor)
                && !/[\w$]/u.test(source[cursor - 1] || '')
                && !/[\w$]/u.test(source[cursor + 'function'.length] || '')) {
                functionCandidate = true;
                cursor += 'function'.length - 1;
                continue;
            }
            if (atCallbackArgumentLevel && character === '=' && nextCharacter === '>') {
                let bodyStart = cursor + 2;
                while (/\s/u.test(source[bodyStart] || '')) bodyStart += 1;
                if (source[bodyStart] === '{') {
                    const bodyEnd = findMatchingBrace(bodyStart);
                    return {
                        name: declaredName,
                        assertive: bodyEnd !== null && hasAssertionSignal(bodyStart + 1, bodyEnd)
                    };
                }
                let expressionEnd = bodyStart;
                let expressionParenthesisDepth = callParenthesisDepth;
                while (expressionEnd < source.length) {
                    if (source[expressionEnd] === '(') expressionParenthesisDepth += 1;
                    if (source[expressionEnd] === ')') {
                        expressionParenthesisDepth -= 1;
                        if (expressionParenthesisDepth === 0) break;
                    }
                    expressionEnd += 1;
                }
                return {
                    name: declaredName,
                    assertive: hasAssertionSignal(bodyStart, expressionEnd)
                };
            }
        }
        return null;
    };

    for (let index = 0; index < source.length; index += 1) {
        const character = source[index];
        const nextCharacter = source[index + 1];
        if (mode === 'line_comment') {
            if (character === '\n') {
                mode = 'code';
                lineLeading = true;
            }
            continue;
        }
        if (mode === 'block_comment') {
            if (character === '\n') lineLeading = true;
            if (character === '*' && nextCharacter === '/') {
                mode = 'code';
                lineLeading = false;
                index += 1;
            }
            continue;
        }
        if (mode !== 'code') {
            if (escaped) {
                escaped = false;
                continue;
            }
            if (character === '\\') {
                escaped = true;
                continue;
            }
            if (mode === 'template') {
                if (character === '`') mode = 'code';
                continue;
            }
            if ((mode === 'single_quote' && character === "'")
                || (mode === 'double_quote' && character === '"')) {
                mode = 'code';
            }
            if (character === '\n') {
                mode = 'code';
                lineLeading = true;
            }
            continue;
        }
        if (character === '\n') {
            lineLeading = true;
            continue;
        }
        if (character === '/' && nextCharacter === '/') {
            mode = 'line_comment';
            lineLeading = false;
            index += 1;
            continue;
        }
        if (character === '/' && nextCharacter === '*') {
            mode = 'block_comment';
            lineLeading = false;
            index += 1;
            continue;
        }
        if (character === "'" || character === '"' || character === '`') {
            mode = character === "'" ? 'single_quote' : character === '"' ? 'double_quote' : 'template';
            lineLeading = false;
            continue;
        }
        if (character === '(') {
            callStack.push(readCallNameBeforeParenthesis(index));
            pendingArrowCallbackBody = false;
            pendingFunctionCallbackBody = false;
            lineLeading = false;
            continue;
        }
        if (character === ')') {
            const closedCall = callStack.pop();
            pendingFunctionCallbackBody = closedCall === 'function';
            pendingArrowCallbackBody = false;
            lineLeading = false;
            continue;
        }
        if (character === '=' && nextCharacter === '>') {
            pendingArrowCallbackBody = true;
            pendingFunctionCallbackBody = false;
            lineLeading = false;
            index += 1;
            continue;
        }
        if (character === '{') {
            const isSuiteCallbackBody = (pendingArrowCallbackBody || pendingFunctionCallbackBody)
                && isEnabledSuiteCall(callStack[callStack.length - 1] ?? null);
            declarationBlockStack.push(!isSuiteCallbackBody);
            pendingArrowCallbackBody = false;
            pendingFunctionCallbackBody = false;
            lineLeading = false;
            continue;
        }
        if (character === '}') {
            declarationBlockStack.pop();
            pendingArrowCallbackBody = false;
            pendingFunctionCallbackBody = false;
            lineLeading = false;
            continue;
        }
        if (lineLeading && (character === ' ' || character === '\t' || character === '\r')) {
            continue;
        }
        if (lineLeading) {
            const declaration = readDirectTestDeclaration(index);
            if (declaration?.name === testName && !declarationBlockStack.includes(true)) {
                return declaration.assertive;
            }
            lineLeading = false;
        }
        if (!/\s/u.test(character)) {
            pendingArrowCallbackBody = false;
            pendingFunctionCallbackBody = false;
        }
    }
    return false;
}

function matchesSensitiveChangedFile(changedFile: string): boolean {
    return TRUST_BOUNDARY_SENSITIVE_CHANGED_FILE_REGEXES.some((pattern) => (
        new RegExp(pattern, 'i').test(changedFile)
    ));
}

function normalizeNegativePath(
    value: unknown,
    boundaryIndex: number,
    pathIndex: number,
    violations: string[]
): TrustBoundaryNegativePath | null {
    const label = `trust_boundary_matrix[${boundaryIndex}].negative_paths[${pathIndex}]`;
    if (!isRecord(value)) {
        violations.push(`${label} must be an object.`);
        return null;
    }
    const kind = normalizeText(value.kind).toLowerCase() as TrustBoundaryNegativePathKind;
    const scenario = normalizeText(value.scenario);
    const expectedBehavior = normalizeText(value.expected_behavior ?? value.expectedBehavior);
    const evidenceFiles = normalizeTextArray(value.evidence_files ?? value.evidenceFiles)
        .map(normalizeTestEvidenceReference);
    if (!TRUST_BOUNDARY_NEGATIVE_PATH_KINDS.includes(kind)) {
        violations.push(`${label}.kind must be one of ${TRUST_BOUNDARY_NEGATIVE_PATH_KINDS.join(', ')}.`);
    }
    if (!scenario) {
        violations.push(`${label}.scenario must name the targeted adversarial path.`);
    } else if (kind === 'other' && !ADVERSARIAL_SCENARIO_PATTERN.test(scenario)) {
        violations.push(`${label}.scenario for kind 'other' must identify a concrete adversarial or failure path.`);
    }
    if (!expectedBehavior) {
        violations.push(`${label}.expected_behavior must state the fail-closed or recovery behavior.`);
    } else if (!FAIL_CLOSED_BEHAVIOR_PATTERN.test(expectedBehavior)) {
        violations.push(`${label}.expected_behavior must state the fail-closed or recovery action.`);
    }
    if (evidenceFiles.length === 0) {
        violations.push(`${label}.evidence_files must cite at least one targeted test or evidence file.`);
    }
    for (const [evidenceIndex, evidenceReference] of evidenceFiles.entries()) {
        const evidenceLabel = `${label}.evidence_files[${evidenceIndex}]`;
        const parsed = parseTestEvidenceReference(evidenceReference);
        if (!parsed) {
            violations.push(`${evidenceLabel} must use path#exact test name.`);
            continue;
        }
        if (parsed.testName !== scenario) {
            violations.push(`${evidenceLabel} test name must exactly equal ${label}.scenario.`);
        }
        if (kind !== 'other' && !parsed.testName.toLowerCase().includes(kind)) {
            violations.push(`${evidenceLabel} test name must identify the '${kind}' adversarial path.`);
        }
    }
    return {
        kind,
        scenario,
        expected_behavior: expectedBehavior,
        evidence_files: evidenceFiles
    };
}

function normalizeBoundaryEntry(
    value: unknown,
    index: number,
    violations: string[]
): TrustBoundaryMatrixEntry | null {
    const label = `trust_boundary_matrix[${index}]`;
    if (!isRecord(value)) {
        violations.push(`${label} must be an object.`);
        return null;
    }
    const boundaryId = normalizeText(value.boundary_id ?? value.boundaryId);
    const boundary = normalizeText(value.boundary ?? value.name);
    const authoritySource = normalizeText(value.authority_source ?? value.authoritySource);
    const mutableInputs = normalizeTextArray(value.mutable_inputs ?? value.mutableInputs);
    const integrityEvidence = normalizeTextArray(
        value.integrity_evidence ?? value.integrityEvidence ?? value.immutable_evidence
    );
    const canonicalReconstruction = normalizeText(
        value.canonical_reconstruction ?? value.canonicalReconstruction
    );
    const toctouReplay = normalizeText(value.toctou_replay ?? value.toctouReplay);
    const rawNegativePaths = Array.isArray(value.negative_paths ?? value.negativePaths)
        ? value.negative_paths ?? value.negativePaths
        : [];
    const negativePaths = (rawNegativePaths as unknown[])
        .map((entry, pathIndex) => normalizeNegativePath(entry, index, pathIndex, violations))
        .filter((entry): entry is TrustBoundaryNegativePath => entry !== null);

    if (!boundaryId) violations.push(`${label}.boundary_id is required.`);
    if (!boundary) violations.push(`${label}.boundary must name the trust boundary.`);
    if (!authoritySource) violations.push(`${label}.authority_source is required.`);
    if (mutableInputs.length === 0) violations.push(`${label}.mutable_inputs must not be empty.`);
    if (integrityEvidence.length === 0) violations.push(`${label}.integrity_evidence must not be empty.`);
    if (!canonicalReconstruction) violations.push(`${label}.canonical_reconstruction is required.`);
    if (!toctouReplay) violations.push(`${label}.toctou_replay is required.`);
    if (negativePaths.length === 0) {
        violations.push(`${label}.negative_paths must contain at least one targeted adversarial path.`);
    }
    return {
        boundary_id: boundaryId,
        boundary,
        authority_source: authoritySource,
        mutable_inputs: mutableInputs,
        integrity_evidence: integrityEvidence,
        canonical_reconstruction: canonicalReconstruction,
        toctou_replay: toctouReplay,
        negative_paths: negativePaths
    };
}

function validateTrustBoundaryEvidenceFiles(
    matrix: readonly TrustBoundaryMatrixEntry[],
    repoRoot: string,
    violations: string[]
): void {
    const resolvedRepoRoot = path.resolve(repoRoot);
    let repoRealPath: string;
    try {
        repoRealPath = fs.realpathSync.native(resolvedRepoRoot);
    } catch {
        violations.push(`trust_boundary_matrix evidence repository root is unavailable: ${resolvedRepoRoot}.`);
        return;
    }
    for (const [boundaryIndex, boundary] of matrix.entries()) {
        for (const [negativePathIndex, negativePath] of boundary.negative_paths.entries()) {
            for (const [evidenceIndex, evidenceReference] of negativePath.evidence_files.entries()) {
                const label = `trust_boundary_matrix[${boundaryIndex}].negative_paths[${negativePathIndex}].evidence_files[${evidenceIndex}]`;
                const parsed = parseTestEvidenceReference(evidenceReference);
                if (!parsed) {
                    continue;
                }
                const { evidenceFile, testName } = parsed;
                const segments = evidenceFile.split('/').filter(Boolean);
                const isRelative = !path.isAbsolute(evidenceFile)
                    && !/^[a-z]:/iu.test(evidenceFile)
                    && !segments.includes('..');
                const isTestPath = segments.some((segment) => /^(?:tests?|__tests__)$/iu.test(segment));
                if (!isRelative || !isTestPath) {
                    violations.push(`${label} must reference an in-repository test file.`);
                    continue;
                }
                const resolvedEvidencePath = path.resolve(resolvedRepoRoot, evidenceFile);
                const relativePath = path.relative(resolvedRepoRoot, resolvedEvidencePath);
                if (!relativePath || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
                    violations.push(`${label} must reference an in-repository test file.`);
                    continue;
                }
                try {
                    fs.lstatSync(resolvedEvidencePath);
                    const evidenceRealPath = fs.realpathSync.native(resolvedEvidencePath);
                    const realRelativePath = path.relative(repoRealPath, evidenceRealPath);
                    if (!realRelativePath || realRelativePath.startsWith(`..${path.sep}`) || path.isAbsolute(realRelativePath)) {
                        violations.push(`${label} must not escape the repository through a symlink or junction.`);
                        continue;
                    }
                    if (!fs.statSync(evidenceRealPath).isFile()) {
                        violations.push(`${label} must reference an existing test file.`);
                        continue;
                    }
                    const source = fs.readFileSync(evidenceRealPath, 'utf8');
                    if (!declaresAssertiveNamedTestCase(source, testName, evidenceFile)) {
                        violations.push(
                            `${label} must reference an exact declared it/test case name with a direct assertion statement outside conditional control flow or a nested callback.`
                        );
                    }
                } catch {
                    violations.push(`${label} must reference an existing test file.`);
                }
            }
        }
    }
}

export function assessTrustBoundaryMatrix(
    value: unknown,
    options: TrustBoundaryMatrixAssessmentOptions = {}
): TrustBoundaryMatrixAssessment {
    const violations: string[] = [];
    const source = Array.isArray(value) ? value : [];
    if (!Array.isArray(value) || source.length === 0) {
        violations.push('trust_boundary_matrix must contain at least one named trust boundary.');
    }
    const matrix = source
        .map((entry, index) => normalizeBoundaryEntry(entry, index, violations))
        .filter((entry): entry is TrustBoundaryMatrixEntry => entry !== null);
    const seenIds = new Set<string>();
    const seenNames = new Set<string>();
    for (const entry of matrix) {
        const normalizedId = entry.boundary_id.toLowerCase();
        const normalizedName = entry.boundary.toLowerCase();
        if (normalizedId && seenIds.has(normalizedId)) {
            violations.push(`Duplicate trust boundary id '${entry.boundary_id}'.`);
        }
        if (normalizedName && seenNames.has(normalizedName)) {
            violations.push(`Duplicate trust boundary name '${entry.boundary}'.`);
        }
        seenIds.add(normalizedId);
        seenNames.add(normalizedName);
    }
    if (options.repoRoot) {
        validateTrustBoundaryEvidenceFiles(matrix, options.repoRoot, violations);
    }
    const canonicalMatrix = JSON.stringify(matrix);
    return {
        matrix,
        matrix_sha256: createHash('sha256').update(canonicalMatrix, 'utf8').digest('hex'),
        violations: [...new Set(violations)]
    };
}

export function assessTrustBoundaryAnalysisApplicability(
    preflight: Record<string, unknown> | null | undefined
): TrustBoundaryAnalysisApplicability {
    if (!preflight) {
        return { required: false, reasons: [] };
    }
    const reasons: string[] = [];
    const triggers = isRecord(preflight.triggers) ? preflight.triggers : {};
    for (const trigger of ['security', 'security_intent', 'protected_control_plane_changed']) {
        if (triggers[trigger] === true) {
            reasons.push(`trigger:${trigger}`);
        }
    }
    const changedFiles = Array.isArray(preflight.changed_files)
        ? preflight.changed_files.map(normalizeChangedFile).filter(Boolean)
        : [];
    for (const changedFile of changedFiles) {
        if (matchesSensitiveChangedFile(changedFile)) {
            reasons.push(`changed_file:${changedFile}`);
        }
    }
    return {
        required: reasons.length > 0,
        reasons: [...new Set(reasons)]
    };
}

export function buildTrustBoundaryMatrixScaffold(): TrustBoundaryMatrixEntry[] {
    return [{
        boundary_id: '',
        boundary: '',
        authority_source: '',
        mutable_inputs: [],
        integrity_evidence: [],
        canonical_reconstruction: '',
        toctou_replay: '',
        negative_paths: [{
            kind: 'other',
            scenario: '',
            expected_behavior: '',
            evidence_files: []
        }]
    }];
}
