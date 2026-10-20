import * as os from 'node:os';
import * as crypto from 'node:crypto';

/**
 * Central redaction utilities for stripping secrets and sensitive host details
 * from diagnostics, artifacts, and user-facing output.
 *
 * Redaction is deterministic: the same input always produces the same redacted
 * token within a single process lifetime, enabling correlation in diagnostic
 * output without leaking real values.
 */

function shortHash(value: string): string {
    return crypto.createHash('sha256').update(value, 'utf8').digest('hex').substring(0, 8);
}

/**
 * Replace a hostname with a deterministic redacted token.
 * Null/empty values pass through unchanged (they carry no sensitive signal).
 */
export function redactHostname(hostname: string | null | undefined): string | null {
    if (hostname == null) {
        return null;
    }
    const trimmed = String(hostname).trim();
    if (!trimmed) {
        return null;
    }
    return `<host-${shortHash(trimmed)}>`;
}

let cachedHomedir: string | null = null;
let cachedUsername: string | null = null;

function getHomedir(): string {
    if (cachedHomedir === null) {
        try {
            cachedHomedir = os.homedir();
        } catch {
            cachedHomedir = '';
        }
    }
    return cachedHomedir;
}

function getUsername(): string {
    if (cachedUsername === null) {
        try {
            cachedUsername = os.userInfo().username;
        } catch {
            cachedUsername = '';
        }
    }
    return cachedUsername;
}

/**
 * Redact absolute paths that may reveal user home directories or usernames.
 *
 * When `repoRoot` is supplied, paths under the repo root are relativized
 * instead of fully redacted to preserve diagnostic utility.
 */
export function redactPath(absolutePath: string, repoRoot?: string): string {
    if (!absolutePath || typeof absolutePath !== 'string') {
        return absolutePath;
    }

    const normalized = absolutePath.replace(/\\/g, '/');

    // If we have a repo root, try to relativize the path first —
    // repo-relative paths are safe to display.
    if (repoRoot) {
        const normalizedRoot = repoRoot.replace(/\\/g, '/').replace(/\/+$/, '');
        if (normalized === normalizedRoot) {
            return '.';
        }
        const rootPrefix = normalizedRoot + '/';
        if (normalized.startsWith(rootPrefix)) {
            return normalized.slice(rootPrefix.length);
        }
        // Case-insensitive comparison for Windows
        if (normalized.toLowerCase().startsWith(rootPrefix.toLowerCase())) {
            return normalized.slice(rootPrefix.length);
        }
    }

    // Redact the user home-directory prefix if present.
    const homedir = getHomedir().replace(/\\/g, '/');
    if (homedir) {
        const homePrefix = homedir.endsWith('/') ? homedir : homedir + '/';
        if (normalized.startsWith(homePrefix) || normalized.toLowerCase().startsWith(homePrefix.toLowerCase())) {
            return `<home>/${normalized.slice(homePrefix.length)}`;
        }
        if (normalized === homedir || normalized.toLowerCase() === homedir.toLowerCase()) {
            return '<home>';
        }
    }

    // Fallback: redact any leading path segment that matches the username.
    const username = getUsername();
    if (username) {
        const escapedUsername = username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const usernamePattern = new RegExp(`([/\\\\])${escapedUsername}([/\\\\]|$)`, 'gi');
        if (usernamePattern.test(normalized)) {
            return normalized.replace(usernamePattern, `$1<user>$2`);
        }
    }

    return absolutePath;
}

const SECRET_ENV_PATTERNS: RegExp[] = [
    /(?:secret|token|password|credential|api[_-]?key|auth|private[_-]?key)/i,
];

const PRIVATE_KEY_BLOCK_PATTERN = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g;
const AUTHORIZATION_PATTERN = /\b(Authorization\s*[:=]\s*)(Bearer|Basic)\s+([^\s"',;]+)/gi;
const URL_PASSWORD_PATTERN = /\b([a-z][a-z0-9+.-]*:\/\/[^:\s/@]+:)([^@\s/]+)(@)/gi;
const TOKEN_LITERAL_PATTERN = /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|npm_[A-Za-z0-9]{20,})\b/g;
const JSON_DOUBLE_QUOTED_FIELD_PATTERN = /("([^"\\]*(?:\\.[^"\\]*)*)"\s*:\s*")([^"\\]*(?:\\.[^"\\]*)*)(")/g;
const JSON_SINGLE_QUOTED_FIELD_PATTERN = /('([^'\\]*(?:\\.[^'\\]*)*)'\s*:\s*')([^'\\]*(?:\\.[^'\\]*)*)(')/g;
const ASSIGNMENT_QUOTED_FIELD_PATTERN = /\b([A-Z0-9_.-]*(?:SECRET|TOKEN|PASSWORD|CREDENTIAL|API[_-]?KEY|PRIVATE[_-]?KEY|AUTHORIZATION|AUTH)[A-Z0-9_.-]*)(\s*[:=]\s*)(["'])([\s\S]*?)(\3)/gi;
const ASSIGNMENT_UNQUOTED_FIELD_PATTERN = /\b([A-Z0-9_.-]*(?:SECRET|TOKEN|PASSWORD|CREDENTIAL|API[_-]?KEY|PRIVATE[_-]?KEY|AUTHORIZATION|AUTH)[A-Z0-9_.-]*)(\s*[:=]\s*)([^\s"',;]+)/gi;
const CANONICAL_REDACTED_UNQUOTED_VALUE_PATTERN = /^<redacted>(?:\\r\\n|\\r|\\n)?$/u;
const TOKEN_TELEMETRY_KEY_PARTS = new Set([
    'token',
    'tokens',
    'economy',
    'count',
    'estimate',
    'estimates',
    'estimated',
    'estimator',
    'saved',
    'saving',
    'savings',
    'raw',
    'filtered',
    'legacy',
    'active',
    'enabled',
    'budget',
    'total',
    'output',
    'usage',
    'forecast',
    'depth',
    'for',
    'chars',
    'per',
    '4',
    'verdict'
]);
const TOKEN_SECRET_CONTEXT_PARTS = new Set(['api', 'access', 'refresh', 'id', 'session', 'auth', 'bearer', 'secret', 'private', 'credential', 'credentials']);

/**
 * Redact environment variable values that look like secrets based on key name.
 * Returns a new object with sensitive values replaced by `<redacted>`.
 */
export function redactEnvObject(env: Record<string, string | undefined>): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(env)) {
        if (value === undefined) {
            continue;
        }
        const isSensitive = SECRET_ENV_PATTERNS.some((p) => p.test(key));
        result[key] = isSensitive ? '<redacted>' : value;
    }
    return result;
}

function splitKeyParts(key: string): string[] {
    return key
        .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(Boolean);
}

function isSensitiveKey(key: string): boolean {
    const parts = splitKeyParts(key);
    if (parts.length === 0) {
        return false;
    }
    if (parts.some((part) => part === 'secret' || part === 'password' || part === 'credential' || part === 'credentials')) {
        return true;
    }
    if (parts.some((part) => part === 'authorization' || part === 'auth')) {
        return true;
    }
    for (let index = 0; index < parts.length - 1; index += 1) {
        if ((parts[index] === 'api' || parts[index] === 'private') && parts[index + 1] === 'key') {
            return true;
        }
    }

    const hasTokenPart = parts.some((part) => part === 'token' || part === 'tokens');
    if (!hasTokenPart) {
        return false;
    }
    if (parts.length === 1) {
        return true;
    }
    if (parts.some((part) => TOKEN_SECRET_CONTEXT_PARTS.has(part))) {
        return true;
    }
    if (parts.every((part) => TOKEN_TELEMETRY_KEY_PARTS.has(part))) {
        return false;
    }
    return true;
}

function isSourceLocationAssignment(key: string, separator: string, value: string): boolean {
    return separator.trim() === ':'
        && /\.[a-z0-9]+$/iu.test(key)
        && /^\d+(?::\d+)?$/u.test(value);
}

/**
 * Redact secret-looking values from free-form text while preserving enough
 * surrounding syntax for diagnostics to remain useful.
 */
export function redactSecretText(text: string): string {
    if (!text || typeof text !== 'string') {
        return text;
    }

    return text
        .replace(PRIVATE_KEY_BLOCK_PATTERN, '<redacted-private-key>')
        .replace(AUTHORIZATION_PATTERN, '$1$2 <redacted>')
        .replace(URL_PASSWORD_PATTERN, '$1<redacted>$3')
        .replace(TOKEN_LITERAL_PATTERN, '<redacted-token>')
        .replace(JSON_DOUBLE_QUOTED_FIELD_PATTERN, (match, prefix: string, key: string, _value: string, suffix: string) => {
            return isSensitiveKey(key) ? `${prefix}<redacted>${suffix}` : match;
        })
        .replace(JSON_SINGLE_QUOTED_FIELD_PATTERN, (match, prefix: string, key: string, _value: string, suffix: string) => {
            return isSensitiveKey(key) ? `${prefix}<redacted>${suffix}` : match;
        })
        .replace(ASSIGNMENT_QUOTED_FIELD_PATTERN, (match, key: string, separator: string, quote: string, value: string, suffix: string) => {
            if (splitKeyParts(key).includes('authorization') && /^(Bearer|Basic)$/i.test(value)) {
                return match;
            }
            return isSensitiveKey(key) ? `${key}${separator}${quote}<redacted>${suffix}` : match;
        })
        .replace(ASSIGNMENT_UNQUOTED_FIELD_PATTERN, (match, key: string, separator: string, value: string) => {
            if (CANONICAL_REDACTED_UNQUOTED_VALUE_PATTERN.test(value)) {
                return match;
            }
            if (splitKeyParts(key).includes('authorization') && /^(Bearer|Basic)$/i.test(value)) {
                return match;
            }
            if (isSourceLocationAssignment(key, separator, value)) {
                return match;
            }
            return isSensitiveKey(key) ? `${key}${separator}<redacted>` : match;
        });
}

/**
 * Redact secret-looking values from JSON-like data before it is written to
 * durable runtime artifacts.
 */
export function redactSensitiveData(value: unknown, keyHint?: string): unknown {
    if (keyHint && isSensitiveKey(keyHint)) {
        if (value == null) {
            return value;
        }
        return '<redacted>';
    }

    if (typeof value === 'string') {
        return redactSecretText(value);
    }
    if (Array.isArray(value)) {
        if (value.every((entry) => typeof entry === 'string')) {
            if (keyHint === 'redacted_lines') {
                const lines = value as string[];
                const joined = lines.join('');
                const alreadyRedacted = redactSecretText(joined) === joined
                    && lines.every((line) => redactSecretText(line) === line);
                return alreadyRedacted
                    ? [...lines]
                    : lines.map(() => '<redacted>');
            }
            const joinedRedacted = redactSecretText(value.join('\n'));
            if (value.some((entry) => /[\r\n]/u.test(entry))) {
                // Elements are multiline values, not output lines: redact them in place unless a
                // secret spans elements, which only the joined redaction can mask.
                const inPlace = (value as string[]).map((entry) => redactSecretText(entry));
                if (inPlace.join('\n') === joinedRedacted) {
                    return inPlace;
                }
            }
            return splitRedactedTextLines(joinedRedacted);
        }
        return value.map((entry) => redactSensitiveData(entry));
    }
    if (!value || typeof value !== 'object') {
        return value;
    }

    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
        result[key] = redactSensitiveData(entry, key);
    }
    return result;
}

export function serializeRedactedJson(value: unknown): string {
    return `${JSON.stringify(redactSensitiveData(value), null, 2)}\n`;
}

export function sha256RedactedJsonPayload(value: unknown): string {
    return crypto.createHash('sha256')
        .update(serializeRedactedJson(value))
        .digest('hex');
}

function splitRedactedTextLines(text: string): string[] {
    const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
    while (lines.length > 0 && lines[lines.length - 1] === '') {
        lines.pop();
    }
    return lines;
}

/**
 * Scrub a free-form diagnostic string of hostnames, home-directory paths,
 * and usernames. Best-effort: applies known-value replacement only.
 */
export function redactDiagnosticText(text: string, repoRoot?: string): string {
    if (!text || typeof text !== 'string') {
        return text;
    }

    let result = redactSecretText(text);

    // Replace the real hostname with a redacted token.
    let currentHostname: string;
    try {
        currentHostname = os.hostname();
    } catch {
        currentHostname = '';
    }
    if (currentHostname) {
        const hostToken = redactHostname(currentHostname)!;
        result = replaceAll(result, currentHostname, hostToken);
    }

    // Replace home-directory prefix.
    const homedir = getHomedir();
    if (homedir) {
        const forwardSlash = homedir.replace(/\\/g, '/');
        const backSlash = homedir.replace(/\//g, '\\');
        result = replaceAllAtPathBoundary(result, forwardSlash, '<home>');
        if (backSlash !== forwardSlash) {
            result = replaceAllAtPathBoundary(result, backSlash, '<home>');
        }
    }

    // Replace bare username occurrences that form a path segment.
    const username = getUsername();
    if (username && username.length >= 2) {
        const escapedUsername = username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const segmentPattern = new RegExp(`([/\\\\])${escapedUsername}([/\\\\])`, 'gi');
        result = result.replace(segmentPattern, '$1<user>$2');
    }

    // Redact paths relative to repo root last so earlier replacements take effect first.
    if (repoRoot) {
        const normalizedRoot = repoRoot.replace(/\\/g, '/');
        const backSlashRoot = repoRoot.replace(/\//g, '\\');
        if (normalizedRoot.length > 3) {
            result = replaceAll(result, normalizedRoot, '<repo>');
        }
        if (backSlashRoot !== normalizedRoot && backSlashRoot.length > 3) {
            result = replaceAll(result, backSlashRoot, '<repo>');
        }
    }

    return result;
}

export interface RedactionContext {
    readonly repoRoot: string | undefined;
    redactHostname(hostname: string | null | undefined): string | null;
    redactPath(absolutePath: string): string;
    redactDiagnosticText(text: string): string;
}

/**
 * Build a reusable redaction context scoped to a repository root.
 */
export function createRedactionContext(repoRoot?: string): RedactionContext {
    return {
        repoRoot,
        redactHostname(hostname: string | null | undefined): string | null {
            return redactHostname(hostname);
        },
        redactPath(absolutePath: string): string {
            return redactPath(absolutePath, repoRoot);
        },
        redactDiagnosticText(text: string): string {
            return redactDiagnosticText(text, repoRoot);
        },
    };
}

function replaceAll(source: string, search: string, replacement: string): string {
    if (!search) {
        return source;
    }
    // Case-insensitive replacement for path segments that may differ in casing.
    const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return source.replace(new RegExp(escaped, 'gi'), replacement);
}

// Like replaceAll, but skips matches that continue a path segment (`/home/dev` must not
// rewrite `/home/dev2/...`).
function replaceAllAtPathBoundary(source: string, search: string, replacement: string): string {
    if (!search) {
        return source;
    }
    const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return source.replace(new RegExp(`${escaped}(?![\\p{L}\\p{N}_-])`, 'giu'), () => replacement);
}

// For testing: reset cached values (not exported at module level).
export function _resetCachedValues(): void {
    cachedHomedir = null;
    cachedUsername = null;
}
