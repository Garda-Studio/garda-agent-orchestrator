const MAX_DIAGNOSTIC_LINES = 40;
const MAX_DIAGNOSTIC_CHARS = 4000;

const DIAGNOSTIC_HINTS = Object.freeze({
    GIT_NOT_AVAILABLE: 'Install git and ensure the executable is available on PATH before running git-based update flows.',
    GIT_TIMEOUT: 'Verify network reachability and repository size, then retry the git update operation.',
    GIT_REF_NOT_FOUND: 'Verify the requested branch, tag, or ref exists in the remote repository.',
    GIT_AUTH_FAILURE: 'Verify repository access, credentials, and token permissions for the requested repository.',
    GIT_REPOSITORY_NOT_FOUND: 'Verify the repository URL is correct and that the repository still exists.',
    GIT_NETWORK_FAILURE: 'Verify network connectivity, DNS, and proxy configuration for git access.',
    NPM_NOT_AVAILABLE: 'Install npm and ensure it is available on PATH before using npm-based update flows.',
    NPM_INSTALL_CANCELLED: 'Retry the npm-based update after the cancellation source has been cleared.',
    NPM_INSTALL_TIMEOUT: 'Verify registry reachability and retry the npm-based update.',
    NPM_PACKAGE_NOT_FOUND: 'Verify the package name and requested version exist in the configured npm registry.',
    NPM_AUTH_FAILURE: 'Verify npm registry credentials and token permissions for the requested package.',
    NPM_NETWORK_FAILURE: 'Verify registry connectivity, DNS, and proxy configuration for npm access.',
    NPM_METADATA_UNAVAILABLE: 'Retry the update after ensuring npm can inspect installed package metadata successfully.',
    NPM_METADATA_EMPTY: 'Ensure npm returned dependency metadata for the installed update package.',
    NPM_METADATA_INVALID: 'Ensure npm returned valid JSON metadata for the installed update package.',
    UPDATE_SOURCE_UNVERIFIED: 'Use an HTTPS or explicit local Git source with a clean, regular-file tree at the requested ref; inspect the source before retrying.',
    UPDATE_SOURCE_PREBUILT_REQUIRED: 'Use a Git ref containing a committed prebuilt bin and dist bundle, or use the trusted npm update path with registry integrity.',
    UPDATE_SOURCE_VERSION_MISSING: 'Ensure the selected update source points to a valid orchestrator bundle containing a VERSION file.',
    UPDATE_SOURCE_VERSION_EMPTY: 'Ensure the selected update source has a non-empty VERSION file.'
} as const);

type KnownLifecycleDiagnosticCode = keyof typeof DIAGNOSTIC_HINTS;

interface LifecycleDiagnosticOptions {
    message?: unknown;
    tool?: unknown;
    code?: unknown;
    sourceReference?: unknown;
    hint?: unknown;
    stderr?: unknown;
    stdout?: unknown;
    detailText?: unknown;
}

export interface LifecycleDiagnosticError extends Error {
    diagnosticTool: string;
    diagnosticCode: string;
    diagnosticSource: string | null;
    diagnosticHint: string | null;
    diagnosticStderr: string;
    diagnosticStdout: string;
    diagnosticText: string;
}

export function normalizeDiagnosticText(value: unknown): string {
    const text = String(value || '')
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        .trim();

    if (!text) {
        return '';
    }

    let lines = text.split('\n');
    let truncated = false;

    if (lines.length > MAX_DIAGNOSTIC_LINES) {
        lines = lines.slice(0, MAX_DIAGNOSTIC_LINES);
        truncated = true;
    }

    let joined = lines.join('\n');
    if (joined.length > MAX_DIAGNOSTIC_CHARS) {
        joined = joined.slice(0, MAX_DIAGNOSTIC_CHARS).trimEnd();
        truncated = true;
    }

    if (truncated) {
        joined += '\n...[truncated]';
    }

    return joined;
}

function matchesAnyPattern(text: string, patterns: readonly string[]): boolean {
    for (const pattern of patterns) {
        if (text.includes(pattern)) {
            return true;
        }
    }
    return false;
}

export function classifyGitDiagnostic(text: string): string {
    const normalized = normalizeDiagnosticText(text).toLowerCase();
    if (!normalized) {
        return 'GIT_UNKNOWN';
    }

    if (matchesAnyPattern(normalized, [
        'remote branch',
        'could not find remote branch',
        'not found in upstream origin',
        'couldn\'t find remote ref'
    ])) {
        return 'GIT_REF_NOT_FOUND';
    }

    if (matchesAnyPattern(normalized, [
        'authentication failed',
        'could not read username',
        'permission denied',
        'access denied',
        'terminal prompts disabled'
    ])) {
        return 'GIT_AUTH_FAILURE';
    }

    if (matchesAnyPattern(normalized, [
        'repository not found',
        'does not appear to be a git repository',
        'not appear to be a git repository',
        'not a git repository'
    ])) {
        return 'GIT_REPOSITORY_NOT_FOUND';
    }

    if (matchesAnyPattern(normalized, [
        'could not resolve host',
        'failed to connect',
        'connection timed out',
        'network is unreachable',
        'unable to access'
    ])) {
        return 'GIT_NETWORK_FAILURE';
    }

    if (matchesAnyPattern(normalized, [
        'timed out',
        'timeout'
    ])) {
        return 'GIT_TIMEOUT';
    }

    return 'GIT_UNKNOWN';
}

export function classifyNpmDiagnostic(text: string): string {
    const normalized = normalizeDiagnosticText(text).toLowerCase();
    if (!normalized) {
        return 'NPM_UNKNOWN';
    }

    if (matchesAnyPattern(normalized, [
        'e404',
        '404 not found',
        'not found - get'
    ])) {
        return 'NPM_PACKAGE_NOT_FOUND';
    }

    if (matchesAnyPattern(normalized, [
        'e401',
        'e403',
        'requires authentication',
        'authorization',
        'auth token',
        'forbidden'
    ])) {
        return 'NPM_AUTH_FAILURE';
    }

    if (matchesAnyPattern(normalized, [
        'enotfound',
        'econnrefused',
        'etimedout',
        'network request',
        'fetch failed',
        'socket hang up'
    ])) {
        return 'NPM_NETWORK_FAILURE';
    }

    if (matchesAnyPattern(normalized, [
        'timed out',
        'timeout'
    ])) {
        return 'NPM_TIMEOUT';
    }

    return 'NPM_UNKNOWN';
}

export function getLifecycleDiagnosticHint(code: string): string | null {
    return code in DIAGNOSTIC_HINTS
        ? DIAGNOSTIC_HINTS[code as KnownLifecycleDiagnosticCode]
        : null;
}

export function createLifecycleDiagnosticError(options: LifecycleDiagnosticOptions): LifecycleDiagnosticError {
    const message = String(options && options.message ? options.message : 'Update diagnostic failure.');
    const tool = String(options && options.tool ? options.tool : 'update');
    const code = String(options && options.code ? options.code : 'UNKNOWN');
    const sourceReference = options && options.sourceReference ? String(options.sourceReference) : null;
    const hint = options && options.hint ? String(options.hint) : getLifecycleDiagnosticHint(code);
    const stderrText = normalizeDiagnosticText(options && options.stderr);
    const stdoutText = normalizeDiagnosticText(options && options.stdout);
    const detailText = normalizeDiagnosticText(options && options.detailText);
    const diagnosticText = [stderrText, stdoutText, detailText].filter(Boolean).join('\n');

    const lines = [
        message,
        `DiagnosticTool: ${tool}`,
        `DiagnosticCode: ${code}`
    ];

    if (sourceReference) {
        lines.push(`DiagnosticSource: ${sourceReference}`);
    }

    if (hint) {
        lines.push(`DiagnosticHint: ${hint}`);
    }

    if (stderrText) {
        lines.push('DiagnosticStderr:');
        lines.push(stderrText);
    }

    if (stdoutText) {
        lines.push('DiagnosticStdout:');
        lines.push(stdoutText);
    }

    if (!stderrText && !stdoutText && detailText) {
        lines.push('DiagnosticText:');
        lines.push(detailText);
    }

    const error = new Error(lines.join('\n')) as LifecycleDiagnosticError;
    error.diagnosticTool = tool;
    error.diagnosticCode = code;
    error.diagnosticSource = sourceReference;
    error.diagnosticHint = hint || null;
    error.diagnosticStderr = stderrText;
    error.diagnosticStdout = stdoutText;
    error.diagnosticText = diagnosticText;
    return error;
}
