import * as path from 'node:path';
import { parseCommandChain } from '../../../../core/command-line';
import { rejectInlineValidationProgram } from '../../../../core/project-validation-command';
import { parseValidationTap } from '../../../../core/project-validation-results';
import { readValidationEventSnapshot } from '../../../../gates/project-validation/attempt-evidence';
import { getChangedTestPathsTargetedByCommandTokens } from '../../../../gates/shared/focused-intermediate-command-grammar';

const MAXIMUM_COMMAND_BYTES = 64 * 1024;
const MAXIMUM_ARGUMENTS = 256;

export function isLiteralIntermediateInvocation(command: string): boolean {
    try {
        if (Buffer.byteLength(command) > MAXIMUM_COMMAND_BYTES) return false;
        const chain = parseCommandChain(command);
        if (chain.length !== 1 || chain[0].length > MAXIMUM_ARGUMENTS) return false;
        const [executable, ...argv] = chain[0];
        rejectInlineValidationProgram(executable, argv);
        return true;
    } catch { return false; }
}

/** Target association is input metadata, not permission or proof of test execution. */
export function getCurrentIntermediateTestTargets(repoRoot: string, command: string, changedFiles: readonly string[]): string[] {
    if (!isLiteralIntermediateInvocation(command)) return [];
    const tokens = parseCommandChain(command)[0];
    const literalPaths = new Set(tokens.slice(1).map(token => path.resolve(repoRoot, token)));
    const suggestedPaths = new Set(getChangedTestPathsTargetedByCommandTokens(tokens, [...changedFiles]));
    return changedFiles.filter(file => literalPaths.has(path.resolve(repoRoot, file)) || suggestedPaths.has(file));
}

export function hasReportedFailedTestCase(output: string): boolean {
    const lines = output.split(/\r?\n/u);
    const start = lines.findIndex(line => /^TAP version 1[34]$/u.test(line));
    if (start < 0) return false;
    // Native capture concatenates stdout and stderr. Keep every root TAP control
    // record, including trailing aborts, while excluding process diagnostics.
    const report = lines.slice(start).filter(line => /^(?:TAP version\b|1\.\.|(?:not )?ok\b|Bail out!)/iu.test(line));
    try {
        const cases = parseValidationTap(report.join('\n'));
        return cases.some(item => item.outcome === 'failed') && !cases.some(item => item.outcome === 'skipped');
    } catch { return false; }
}

export function observeNativeIntermediateScope(repoRoot: string, taskId: string, preflightPath?: string): {
    preflight_sha256: string | null; scope_content_sha256: string | null; error: string | null;
} {
    try {
        if (!preflightPath) throw new Error('Native command observation requires the current preflight path.');
        // One authenticated observation owns timeline, preflight and staged/worktree parity together.
        const snapshot = readValidationEventSnapshot(repoRoot, taskId);
        if (path.resolve(preflightPath) !== path.resolve(snapshot.preflight_path))
            throw new Error('Preflight path must match the latest native classification for this task.');
        return { preflight_sha256: snapshot.preflight_sha256, scope_content_sha256: snapshot.scope_content_sha256, error: null };
    } catch (error) {
        return { preflight_sha256: null, scope_content_sha256: null,
            error: error instanceof Error ? error.message.split('\n')[0].slice(0, 240) : 'Native command scope unavailable.' };
    }
}
