import * as path from 'node:path';
import { parseCommandChain } from '../../../../core/command-line';
import { inspectValidationCommand } from '../../../../core/validation-command-contract';
import { selectionMatchesCase, type IntermediateSelection } from '../../../../core/intermediate-selected-cases';
import { parseValidationTap } from '../../../../core/project-validation-results';
import { validationDigest } from '../../../../core/project-validation-identity';
import { readValidationEventSnapshot } from '../../../../gates/project-validation/attempt-evidence';
import { getChangedTestPathsTargetedByCommandTokens } from '../../../../gates/shared/focused-intermediate-command-grammar';

const MAXIMUM_REPORTED_CASES = 1024;
type ReportedCase = ReturnType<typeof parseValidationTap>[number];
interface CaseNode { item: ReportedCase; children: CaseNode[] }
interface ReportGroup {
    indent: number; lines: string[]; children: Map<number, CaseNode[]>; pending: CaseNode[] | null;
}

function finishReportGroup(group: ReportGroup): CaseNode[] {
    if (group.pending) throw new Error('Nested TAP requires its parent result.');
    return parseValidationTap(group.lines.join('\n')).map((item, index) => ({
        item, children: group.children.get(index + 1) || []
    }));
}

export function isLiteralIntermediateInvocation(command: string): boolean {
    return command.trim().length > 0 && inspectValidationCommand(command, 'validation').supported;
}

/** Target association is input metadata, not permission or proof of test execution. */
export function getCurrentIntermediateTestTargets(repoRoot: string, command: string, changedFiles: readonly string[],
    selection?: IntermediateSelection): string[] {
    if (!isLiteralIntermediateInvocation(command)) return [];
    if (selection) return changedFiles.filter(file => selectionMatchesCase(selection, file));
    const tokens = parseCommandChain(command)[0];
    const literalPaths = new Set(tokens.slice(1).map(token => path.resolve(repoRoot, token)));
    const suggestedPaths = new Set(getChangedTestPathsTargetedByCommandTokens(tokens, [...changedFiles]));
    return changedFiles.filter(file => literalPaths.has(path.resolve(repoRoot, file)) || suggestedPaths.has(file));
}

export function readReportedTestCases(output: string): ReturnType<typeof parseValidationTap> | null {
    const lines = output.split(/\r?\n/u);
    const start = lines.findIndex(line => /^TAP version 1[34]$/u.test(line));
    if (start < 0) return null;
    try {
        const frame = (indent: number): ReportGroup => ({ indent, lines: [], children: new Map(), pending: null });
        const groups = [frame(0)];
        let diagnosticIndent: number | null = null, count = 0;
        for (const line of lines.slice(start)) {
            if (diagnosticIndent !== null) {
                if (line.trim() === '...' && line.search(/\S/u) === diagnosticIndent) diagnosticIndent = null;
                else if (line.trim() && line.search(/\S/u) < diagnosticIndent) return null;
                continue;
            }
            const diagnostic = /^( +)---\s*$/u.exec(line);
            if (diagnostic) {
                if (diagnostic[1].length <= groups.at(-1)!.indent || !/^(?:not )?ok\b/iu.test(groups.at(-1)!.lines.at(-1) || '')) return null;
                diagnosticIndent = diagnostic[1].length; continue;
            }
            // Preserve controls at every nesting level; stderr diagnostics are not TAP cases.
            const control = /^( *)(TAP version\b.*|1\.\..*|(?:not )?ok\b.*|Bail out!.*)$/iu.exec(line);
            if (!control) continue;
            const indent = control[1].length, text = control[2];
            while (groups.length > 1 && groups.at(-1)!.indent > indent) {
                const children = finishReportGroup(groups.pop()!);
                if (groups.at(-1)!.indent < indent) groups.push(frame(indent));
                if (groups.at(-1)!.pending) return null;
                groups.at(-1)!.pending = children;
            }
            if (groups.at(-1)!.indent < indent) groups.push(frame(indent));
            if (groups.length > MAXIMUM_REPORTED_CASES) return null;
            const group = groups.at(-1)!, result = /^(?:not )?ok\s+(\d+)\s+-/iu.exec(text);
            if (result && ++count > MAXIMUM_REPORTED_CASES) return null;
            if (group.pending) {
                if (!result) return null;
                group.children.set(Number(result[1]), group.pending); group.pending = null;
            }
            group.lines.push(text);
        }
        if (diagnosticIndent !== null || groups.length !== 1) return null;
        const pending = finishReportGroup(groups[0]).map(node => ({ node, parent: 'tap-root' }));
        const cases: ReportedCase[] = [];
        while (pending.length) {
            const { node, parent } = pending.pop()!;
            const id = validationDigest([parent, node.item.id]);
            cases.push({ ...node.item, id });
            for (const child of node.children) pending.push({ node: child, parent: id });
        }
        return cases;
    } catch { return null; }
}

export function hasReportedFailedTestCase(output: string): boolean {
    const cases = readReportedTestCases(output);
    return !!cases && cases.some(item => item.outcome === 'failed') && !cases.some(item => item.outcome === 'skipped');
}

export function observeNativeIntermediateScope(repoRoot: string, taskId: string, preflightPath?: string): {
    preflight_sha256: string | null; scope_content_sha256: string | null; error: string | null;
    changed_files: string[];
} {
    try {
        if (!preflightPath) throw new Error('Native command observation requires the current preflight path.');
        // One authenticated observation owns timeline, preflight and staged/worktree parity together.
        const snapshot = readValidationEventSnapshot(repoRoot, taskId);
        if (path.resolve(preflightPath) !== path.resolve(snapshot.preflight_path))
            throw new Error('Preflight path must match the latest native classification for this task.');
        return { preflight_sha256: snapshot.preflight_sha256, scope_content_sha256: snapshot.scope_content_sha256,
            changed_files: snapshot.changed_files, error: null };
    } catch (error) {
        return { preflight_sha256: null, scope_content_sha256: null, changed_files: [],
            error: error instanceof Error ? error.message.split('\n')[0].slice(0, 240) : 'Native command scope unavailable.' };
    }
}
