export function extractReviewVerdictToken(
    content: unknown,
    passVerdict: string | null,
    failVerdict: string | null = null,
    reviewType: string | null = null
): string | null {
    const tokenMatch = extractReviewVerdictTokenMatch(content, buildReviewVerdictTokenSet(
        reviewType,
        passVerdict,
        failVerdict
    ));
    return tokenMatch?.canonicalToken ?? null;
}

export interface ReviewVerdictTokenSet {
    canonicalPassToken: string | null;
    canonicalFailToken: string | null;
    passTokens: string[];
    failTokens: string[];
}

export interface ReviewVerdictTokenMatch {
    canonicalToken: string;
    matchedToken: string;
    outcome: 'pass' | 'fail';
}

function normalizeReviewVerdictToken(value: string | null | undefined): string | null {
    const normalized = String(value || '').trim().replace(/\s+/g, ' ');
    return normalized || null;
}

function dedupeReviewVerdictTokens(values: Array<string | null | undefined>): string[] {
    const result: string[] = [];
    const seen = new Set<string>();
    for (const value of values) {
        const normalized = normalizeReviewVerdictToken(value);
        if (!normalized || seen.has(normalized)) {
            continue;
        }
        seen.add(normalized);
        result.push(normalized);
    }
    return result;
}

function formatTypedReviewVerdictToken(reviewType: string | null | undefined, outcome: 'PASSED' | 'FAILED'): string | null {
    const reviewLabel = String(reviewType || '')
        .trim()
        .toUpperCase()
        .replace(/[^A-Z0-9]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    return reviewLabel ? `${reviewLabel} REVIEW ${outcome}` : null;
}

function getReviewVerdictPassAliases(reviewType: string | null | undefined): Array<string | null> {
    const normalizedReviewType = String(reviewType || '').trim().toLowerCase();
    if (normalizedReviewType === 'code') {
        return ['CODE REVIEW PASSED', 'REVIEW PASSED'];
    }
    return [];
}

function getReviewVerdictFailAliases(reviewType: string | null | undefined): Array<string | null> {
    const normalizedReviewType = String(reviewType || '').trim().toLowerCase();
    if (normalizedReviewType === 'code') {
        return ['CODE REVIEW FAILED', 'REVIEW FAILED'];
    }
    return [];
}

export function buildReviewVerdictTokenSet(
    reviewType: string | null | undefined,
    passVerdict: string | null,
    failVerdict: string | null = null
): ReviewVerdictTokenSet {
    const canonicalPassToken = normalizeReviewVerdictToken(passVerdict);
    const canonicalFailToken = normalizeReviewVerdictToken(failVerdict)
        || (canonicalPassToken ? canonicalPassToken.replace(/\bPASSED\b/g, 'FAILED') : null);

    return {
        canonicalPassToken,
        canonicalFailToken,
        passTokens: dedupeReviewVerdictTokens([
            canonicalPassToken,
            formatTypedReviewVerdictToken(reviewType, 'PASSED'),
            ...getReviewVerdictPassAliases(reviewType)
        ]),
        failTokens: dedupeReviewVerdictTokens([
            canonicalFailToken,
            formatTypedReviewVerdictToken(reviewType, 'FAILED'),
            ...getReviewVerdictFailAliases(reviewType)
        ])
    };
}

export function formatReviewVerdictTokenList(tokens: readonly string[]): string {
    return tokens.length > 0
        ? tokens.map((token) => `'${token}'`).join(', ')
        : '<none>';
}

export function formatAcceptedReviewVerdictTokens(tokens: ReviewVerdictTokenSet): string {
    return `Accepted PASS tokens: ${formatReviewVerdictTokenList(tokens.passTokens)}; ` +
        `accepted FAIL tokens: ${formatReviewVerdictTokenList(tokens.failTokens)}.`;
}

function normalizeReviewVerdictCandidateLine(line: string): string {
    let normalized = line.trim();
    normalized = normalized.replace(/^[-*+]\s+/, '');
    if (/^`.+`$/.test(normalized)) {
        normalized = normalized.slice(1, -1).trim();
    }
    return normalized;
}

function matchReviewVerdictCandidateLine(
    line: string,
    tokenSet: ReviewVerdictTokenSet
): ReviewVerdictTokenMatch | null {
    if (tokenSet.canonicalFailToken) {
        for (const failToken of tokenSet.failTokens) {
            if (line === failToken) {
                return {
                    canonicalToken: tokenSet.canonicalFailToken,
                    matchedToken: failToken,
                    outcome: 'fail'
                };
            }
        }
    }
    if (tokenSet.canonicalPassToken) {
        for (const passToken of tokenSet.passTokens) {
            if (line === passToken) {
                return {
                    canonicalToken: tokenSet.canonicalPassToken,
                    matchedToken: passToken,
                    outcome: 'pass'
                };
            }
        }
    }
    return null;
}

interface ReviewVerdictTextState {
    fence: string | null;
    exampleHeadingLevel: number | null;
    exampleLabel: boolean;
    inVerdictSection: boolean;
    hasVerdictSection: boolean;
    currentVerdictHasToken: boolean;
    hasEmptyVerdictSection: boolean;
    fenceContainerIndent: number | null;
    exampleContainerIndent: number | null;
    verdictContainerIndent: number | null;
    listContainerIndents: number[];
}

function reviewWhitespaceWidth(whitespace: string, startColumn = 0): number {
    let column = startColumn;
    for (const character of whitespace) {
        column += character === '\t' ? 4 - column % 4 : 1;
    }
    return column - startColumn;
}

function prepareReviewVerdictLine(rawLine: string, state: ReviewVerdictTextState): {
    line: string; containerIndent: number | null;
} {
    const expandedLine = rawLine.replace(/^[ \t]+/, (prefix) => ' '.repeat(reviewWhitespaceWidth(prefix)));
    const leadingSpaces = expandedLine.match(/^ */)![0].length;
    if (expandedLine.trim()) {
        while (state.listContainerIndents.length > 0 && leadingSpaces < state.listContainerIndents.at(-1)!) {
            state.listContainerIndents.pop();
        }
        for (const key of ['fenceContainerIndent', 'exampleContainerIndent', 'verdictContainerIndent'] as const) {
            if (state[key] === null || leadingSpaces >= state[key]!) {
                continue;
            }
            if (key === 'fenceContainerIndent') {
                state.fence = null;
            } else if (key === 'exampleContainerIndent') {
                state.exampleLabel = false;
                state.exampleHeadingLevel = null;
            } else {
                state.hasEmptyVerdictSection ||= state.inVerdictSection && !state.currentVerdictHasToken;
                state.inVerdictSection = false;
                state.currentVerdictHasToken = false;
            }
            state[key] = null;
        }
    }
    const parentIndent = state.fence ? state.fenceContainerIndent
        : state.listContainerIndents.at(-1) ?? state.exampleContainerIndent ?? state.verdictContainerIndent;
    const line = parentIndent === null ? expandedLine : expandedLine.slice(parentIndent);
    const bullet = state.fence ? null : line.match(/^( {0,3})[-*+]([ \t]+)/);
    if (!bullet) {
        return { line, containerIndent: parentIndent };
    }
    const markerColumn = (parentIndent ?? 0) + bullet[1].length + 1;
    const separatorWidth = reviewWhitespaceWidth(bullet[2], markerColumn);
    const requiredSpacing = separatorWidth <= 4 ? separatorWidth : 1;
    const containerIndent = markerColumn + requiredSpacing;
    state.listContainerIndents.push(containerIndent);
    return {
        line: ' '.repeat(separatorWidth - requiredSpacing) + line.slice(bullet[0].length),
        containerIndent
    };
}

function isReviewVerdictExampleLabel(line: string, isHeading = false): boolean {
    const label = line.replace(/[*_`]/g, '').trim();
    if (isHeading) {
        return /^(?:(?:allowed|accepted)\b.*\btokens?\b|examples?\b)/i.test(label);
    }
    return /^(?:(?:allowed|accepted)(?:\s+(?:pass|fail|review|verdict))*\s+tokens?|examples?(?:\s+(?:pass|fail))?(?:\s+(?:line|verdict|tokens?))?)(?:\s*:|$)/i.test(label);
}

function consumeReviewVerdictFence(line: string, state: ReviewVerdictTextState): boolean {
    const fence = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (!state.fence) {
        if (!fence || (fence[1][0] === '`' && line.slice(fence[0].length).includes('`'))) {
            return false;
        }
        state.fence = fence[1];
    } else if (fence && fence[1][0] === state.fence[0]
        && fence[1].length >= state.fence.length && /^ {0,3}(`+|~+)[ \t]*$/.test(line)) {
        state.fence = null;
    }
    return true;
}

function consumeReviewVerdictHeading(
    line: string, state: ReviewVerdictTextState, containerIndent: number | null
): boolean {
    const heading = line.match(/^ {0,3}(#{1,6})[ \t]+(.+)$/);
    if (!heading) {
        return false;
    }
    const level = heading[1].length;
    if ((state.exampleHeadingLevel !== null || state.exampleLabel)
        && containerIndent !== null
        && (state.exampleContainerIndent === null || containerIndent > state.exampleContainerIndent)) {
        return true;
    }
    if (state.exampleHeadingLevel !== null && level > state.exampleHeadingLevel) {
        return true;
    }
    if (containerIndent !== null && isReviewVerdictExampleLabel(heading[2], true)) {
        state.exampleHeadingLevel = level;
        state.exampleLabel = false;
        state.exampleContainerIndent ??= containerIndent;
        return true;
    }
    state.hasEmptyVerdictSection ||= state.inVerdictSection && !state.currentVerdictHasToken;
    state.currentVerdictHasToken = false;
    state.exampleHeadingLevel = null;
    state.exampleLabel = false;
    state.exampleContainerIndent = null;
    state.inVerdictSection = false;
    state.verdictContainerIndent = null;
    if (isReviewVerdictExampleLabel(heading[2], true)) {
        state.exampleHeadingLevel = level;
    } else if (level >= 2 && /^verdict$/i.test(heading[2].trim())) {
        state.hasVerdictSection = true;
        state.inVerdictSection = true;
        state.verdictContainerIndent = containerIndent;
    }
    return true;
}

function scanReviewVerdictCandidates(content: unknown, tokenSet: ReviewVerdictTokenSet) {
    const reviewText = String(content || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const state: ReviewVerdictTextState = {
        fence: null,
        exampleHeadingLevel: null,
        exampleLabel: false,
        inVerdictSection: false,
        hasVerdictSection: false,
        currentVerdictHasToken: false,
        hasEmptyVerdictSection: false,
        fenceContainerIndent: null,
        exampleContainerIndent: null,
        verdictContainerIndent: null,
        listContainerIndents: []
    };
    let match: ReviewVerdictTokenMatch | null = null;
    let sectionMatch: ReviewVerdictTokenMatch | null = null;
    let ambiguous = false;
    for (const rawLine of reviewText.split('\n')) {
        const { line, containerIndent } = prepareReviewVerdictLine(rawLine, state);
        if (consumeReviewVerdictFence(line, state)) {
            state.fenceContainerIndent = state.fence ? containerIndent : null;
            continue;
        }
        if (consumeReviewVerdictHeading(line, state, containerIndent)) {
            continue;
        }
        if (state.exampleHeadingLevel !== null || state.exampleLabel) {
            continue;
        }
        if (/^ {0,3}\S/.test(line) && isReviewVerdictExampleLabel(line)) {
            state.exampleLabel = true;
            state.exampleContainerIndent = containerIndent;
            continue;
        }
        const candidate = matchReviewVerdictCandidateLine(normalizeReviewVerdictCandidateLine(rawLine), tokenSet);
        if (candidate) {
            ambiguous ||= match !== null && candidate.outcome !== match.outcome;
            match ||= candidate;
            if (state.inVerdictSection) {
                state.currentVerdictHasToken = true;
                sectionMatch ||= candidate;
            }
        }
    }
    const invalidVerdict = ambiguous || state.hasEmptyVerdictSection
        || (state.inVerdictSection && !state.currentVerdictHasToken);
    return {
        hasVerdictSection: state.hasVerdictSection,
        match: invalidVerdict ? null : match,
        sectionMatch: invalidVerdict ? null : sectionMatch
    };
}

export function extractReviewVerdictSectionTokenMatch(
    content: unknown,
    tokenSet: ReviewVerdictTokenSet
): ReviewVerdictTokenMatch | null {
    return scanReviewVerdictCandidates(content, tokenSet).sectionMatch;
}

export function extractReviewVerdictTokenMatch(
    content: unknown,
    tokenSet: ReviewVerdictTokenSet
): ReviewVerdictTokenMatch | null {
    const candidates = scanReviewVerdictCandidates(content, tokenSet);
    return candidates.hasVerdictSection ? candidates.sectionMatch : candidates.match;
}
