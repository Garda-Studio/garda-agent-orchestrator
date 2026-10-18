import { normalizePath } from '../shared/helpers';
import {
    type FullSuiteValidationConfig,
    type FullSuiteValidationCycleBinding,
    type FullSuiteTimeoutRepairTaskProposal,
    type FullSuiteValidationResult
} from './full-suite-validation-types';
import { isPlainRecord } from '../../core/records';
import * as path from 'node:path';
import { resolveNodeFoundationFailureSource } from '../../core/validation/node-foundation-source-attribution';
import { MAX_BOUNDARY_SOURCE_REFERENCES } from '../../core/trust-boundary-source-evidence';

function hasTrueFlag(record: Record<string, unknown>, key: string): boolean {
    return record[key] === true;
}

function hasRequiredReview(preflight: Record<string, unknown>): boolean {
    const requiredReviews = isPlainRecord(preflight.required_reviews) ? preflight.required_reviews : {};
    return Object.values(requiredReviews).some((value) => value === true);
}

export function isFullSuiteNotRequiredForDocsOnlyScope(preflight: Record<string, unknown>): boolean {
    const scopeCategory = String(preflight.scope_category || '').trim().toLowerCase();
    if (scopeCategory !== 'docs-only') {
        return false;
    }

    const changedFiles = Array.isArray(preflight.changed_files)
        ? preflight.changed_files.map((entry) => String(entry || '').trim()).filter(Boolean)
        : [];
    if (changedFiles.length === 0) {
        return false;
    }

    const triggers = isPlainRecord(preflight.triggers) ? preflight.triggers : {};
    const executionTriggers = [
        'runtime_code_changed',
        'test',
        'infra',
        'performance'
    ];
    if (executionTriggers.some((key) => hasTrueFlag(triggers, key))) {
        return false;
    }

    return true;
}

export function isFullSuiteNotRequiredForZeroDiffNoReviewableScope(preflight: Record<string, unknown>): boolean {
    const zeroDiffGuard = isPlainRecord(preflight.zero_diff_guard) ? preflight.zero_diff_guard : {};
    const profileGuardrails = isPlainRecord(preflight.profile_guardrails) ? preflight.profile_guardrails : {};
    return zeroDiffGuard.zero_diff_detected === true
        && String(zeroDiffGuard.status || '').trim() === 'BASELINE_ONLY'
        && zeroDiffGuard.completion_requires_audited_no_op === true
        && profileGuardrails.zero_diff_no_reviewable_scope === true
        && !hasRequiredReview(preflight);
}

export function buildFullSuiteTimeoutRepairTaskProposal(taskId: string): FullSuiteTimeoutRepairTaskProposal {
    return {
        suggested_task_id: `${taskId}-F1`,
        title: 'Fix full-suite timeout blocker',
        area: 'workflow/full-suite-timeout',
        rationale:
            `Full-suite validation for ${taskId} timed out after exhausting the configured timeout retry policy. ` +
            'Materialize this audited follow-up before launching reviewers or continuing task closeout.'
    };
}

export function compactGreenSummary(outputLines: string[], maxLines: number): string[] {
    if (outputLines.length === 0) {
        return ['Full suite passed (no output).'];
    }

    const summaryLines: string[] = [];
    const nodeTestPass = extractMetricLine(outputLines, /^#\s*(pass|tests)\s+\d+/i);
    if (nodeTestPass) {
        summaryLines.push(nodeTestPass);
        const nodeTestFail = extractMetricLine(outputLines, /^#\s*fail\s+\d+/i);
        if (nodeTestFail) summaryLines.push(nodeTestFail);
        const nodeTestDuration = extractMetricLine(outputLines, /^#\s*duration_ms\s/i);
        if (nodeTestDuration) summaryLines.push(nodeTestDuration);
        appendNodeFoundationTelemetryLines(summaryLines, outputLines, maxLines);
        return summaryLines.slice(0, maxLines);
    }

    const totalTests = extractMetricLine(outputLines, /tests?\s+(\d+)\s+(passed|pass)/i)
        || extractMetricLine(outputLines, /(\d+)\s+passing/i)
        || extractTailSummary(outputLines);
    if (totalTests) {
        summaryLines.push(totalTests);
    }

    const durationLine = extractMetricLine(outputLines, /duration|time|elapsed|took/i);
    if (durationLine && durationLine !== totalTests) {
        summaryLines.push(durationLine);
    }
    appendNodeFoundationTelemetryLines(summaryLines, outputLines, maxLines);

    if (summaryLines.length === 0) {
        return outputLines.slice(-Math.min(maxLines, outputLines.length));
    }

    return summaryLines.slice(0, maxLines);
}

function appendNodeFoundationTelemetryLines(summaryLines: string[], outputLines: string[], maxLines: number): void {
    const primaryComparison = findPrimaryShardComparisonLine(outputLines);
    if (primaryComparison) {
        const runtimeLine = findPrimaryShardRuntimeLine(outputLines)
            || findNearestPreviousMatchingLine(
                outputLines,
                primaryComparison.index,
                /^NODE_FOUNDATION_TEST_SHARD_RUNTIME\s+/i
            );
        appendSummaryLine(summaryLines, runtimeLine, maxLines);
        appendSummaryLine(summaryLines, primaryComparison.line, maxLines);
    } else {
        appendLatestMatchingLine(summaryLines, outputLines, /^NODE_FOUNDATION_TEST_SHARD_RUNTIME\s+/i, maxLines);
    }
    appendSlowestKnownTestLines(summaryLines, outputLines, maxLines);
}

function findPrimaryShardComparisonLine(outputLines: string[]): { line: string; index: number; } | null {
    let best: { line: string; index: number; postRun: boolean; knownCount: number; totalCount: number; } | null = null;
    for (let index = 0; index < outputLines.length; index += 1) {
        const line = outputLines[index].trim();
        if (!/^NODE_FOUNDATION_TEST_SHARD_COMPARISON\s+/i.test(line)) {
            continue;
        }
        const telemetryKnown = line.match(/\btelemetry_known=(\d+)\/(\d+)\b/u);
        const knownCount = telemetryKnown && typeof telemetryKnown[1] === 'string'
            ? Number.parseInt(telemetryKnown[1], 10)
            : 0;
        const totalCount = telemetryKnown && typeof telemetryKnown[2] === 'string'
            ? Number.parseInt(telemetryKnown[2], 10)
            : 0;
        const postRun = /\bsource=post_run_telemetry\b/u.test(line);
        if (
            !best
            || (postRun && !best.postRun)
            || (postRun === best.postRun && knownCount > best.knownCount)
            || (postRun === best.postRun && knownCount === best.knownCount && totalCount > best.totalCount)
        ) {
            best = { line, index, postRun, knownCount, totalCount };
        }
    }
    return best ? { line: best.line, index: best.index } : null;
}

function findPrimaryShardRuntimeLine(outputLines: string[]): string | null {
    let best: { line: string; surfaceCount: number; concurrency: number; } | null = null;
    for (const rawLine of outputLines) {
        const line = rawLine.trim();
        if (!/^NODE_FOUNDATION_TEST_SHARD_RUNTIME\s+/i.test(line)) {
            continue;
        }
        const groupedShards = parseMarkerIntegerField(line, 'grouped_shards');
        const isolatedFiles = parseMarkerIntegerField(line, 'isolated_files');
        const serialFiles = parseMarkerIntegerField(line, 'serial_files');
        const concurrency = parseMarkerIntegerField(line, 'concurrency');
        const surfaceCount = groupedShards + isolatedFiles + serialFiles;
        if (
            !best
            || surfaceCount > best.surfaceCount
            || (surfaceCount === best.surfaceCount && concurrency > best.concurrency)
        ) {
            best = { line, surfaceCount, concurrency };
        }
    }
    return best?.line ?? null;
}

function parseMarkerIntegerField(line: string, fieldName: string): number {
    const match = line.match(new RegExp(`\\b${fieldName}=(\\d+)\\b`, 'u'));
    return match && typeof match[1] === 'string' ? Number.parseInt(match[1], 10) : 0;
}

function findNearestPreviousMatchingLine(outputLines: string[], startIndex: number, pattern: RegExp): string | null {
    for (let index = startIndex - 1; index >= 0; index -= 1) {
        const line = outputLines[index].trim();
        if (pattern.test(line)) {
            return line;
        }
    }
    return null;
}

function appendLatestMatchingLine(
    summaryLines: string[],
    outputLines: string[],
    pattern: RegExp,
    maxLines: number
): void {
    if (summaryLines.length >= maxLines) {
        return;
    }
    const matchedLine = extractMetricLine(outputLines, pattern);
    appendSummaryLine(summaryLines, matchedLine, maxLines);
}

function appendSummaryLine(summaryLines: string[], line: string | null, maxLines: number): void {
    if (line && summaryLines.length < maxLines && !summaryLines.includes(line)) {
        summaryLines.push(line);
    }
}

function appendSlowestKnownTestLines(summaryLines: string[], outputLines: string[], maxLines: number): void {
    const availableSlots = Math.max(0, maxLines - summaryLines.length);
    if (availableSlots === 0) {
        return;
    }
    const slowestLines = outputLines
        .map((line) => line.trim())
        .filter((line) => /^NODE_FOUNDATION_TEST_SLOWEST\s+/i.test(line))
        .slice(0, Math.min(availableSlots, 3));
    summaryLines.push(...slowestLines);
}

function extractMetricLine(lines: string[], pattern: RegExp): string | null {
    for (let index = lines.length - 1; index >= 0; index -= 1) {
        if (pattern.test(lines[index])) {
            return lines[index].trim();
        }
    }
    return null;
}

function extractTailSummary(lines: string[]): string | null {
    for (let index = lines.length - 1; index >= 0; index -= 1) {
        const stripped = lines[index].trim();
        if (stripped) {
            return stripped;
        }
    }
    return null;
}

export function compactRedFailureChunks(outputLines: string[], chunkLines: number): string[][] {
    if (outputLines.length === 0) {
        return [['Full suite failed (no output captured).']];
    }

    const failureIndices: number[] = [];
    for (let index = 0; index < outputLines.length; index += 1) {
        const line = outputLines[index];
        if (/\bfail(ed|ure|ing)?\b/i.test(line) || /\berror\b/i.test(line) || /\bnot ok\b/i.test(line)) {
            failureIndices.push(index);
        }
    }

    if (failureIndices.length === 0) {
        return [outputLines.slice(-chunkLines)];
    }

    const chunks: string[][] = [];
    const contextBefore = Math.max(2, Math.floor(chunkLines * 0.2));
    const contextAfter = chunkLines - contextBefore;
    const usedLines = new Set<number>();

    for (const failIndex of failureIndices) {
        const start = Math.max(0, failIndex - contextBefore);
        const end = Math.min(outputLines.length, failIndex + contextAfter);
        const chunk: string[] = [];

        for (let lineIndex = start; lineIndex < end; lineIndex += 1) {
            if (!usedLines.has(lineIndex)) {
                chunk.push(outputLines[lineIndex]);
                usedLines.add(lineIndex);
            }
        }

        if (chunk.length > 0) {
            chunks.push(chunk);
        }

        if (chunks.length >= 3) {
            break;
        }
    }

    if (chunks.length === 0) {
        chunks.push(outputLines.slice(-chunkLines));
    }

    return chunks;
}

export function buildSkippedResult(
    config: FullSuiteValidationConfig,
    cycleBinding?: FullSuiteValidationCycleBinding
): FullSuiteValidationResult {
    return {
        status: 'SKIPPED',
        enabled: false,
        command: config.command,
        placement: config.placement,
        required: false,
        skip_reason: 'CONFIG_DISABLED',
        exit_code: null,
        timed_out: false,
        output_artifact_path: null,
        compact_summary: ['Full-suite validation is disabled.'],
        failure_chunks: [],
        out_of_scope_failure_policy: config.out_of_scope_failure_policy,
        out_of_scope_failure_detected: false,
        out_of_scope_audit_verdict: 'NOT_APPLICABLE',
        violations: [],
        warnings: [],
        cycle_binding: cycleBinding
    };
}

export function buildDocsOnlyNotRequiredResult(
    config: FullSuiteValidationConfig,
    cycleBinding?: FullSuiteValidationCycleBinding
): FullSuiteValidationResult {
    return {
        status: 'SKIPPED',
        enabled: config.enabled,
        command: config.command,
        placement: config.placement,
        required: false,
        skip_reason: 'DOCS_ONLY_SCOPE_NOT_REQUIRED',
        exit_code: null,
        timed_out: false,
        output_artifact_path: null,
        compact_summary: ['Full-suite validation is not required for this docs-only scope.'],
        failure_chunks: [],
        out_of_scope_failure_policy: config.out_of_scope_failure_policy,
        out_of_scope_failure_detected: false,
        out_of_scope_audit_verdict: 'NOT_APPLICABLE',
        violations: [],
        warnings: [],
        cycle_binding: cycleBinding
    };
}

export function buildZeroDiffNoReviewableNotRequiredResult(
    config: FullSuiteValidationConfig,
    cycleBinding?: FullSuiteValidationCycleBinding
): FullSuiteValidationResult {
    return {
        status: 'SKIPPED',
        enabled: config.enabled,
        command: config.command,
        placement: config.placement,
        required: false,
        skip_reason: 'ZERO_DIFF_NO_REVIEWABLE_SCOPE_NOT_REQUIRED',
        exit_code: null,
        timed_out: false,
        output_artifact_path: null,
        compact_summary: ['Full-suite validation is not required for this zero-diff no-reviewable scope.'],
        failure_chunks: [],
        out_of_scope_failure_policy: config.out_of_scope_failure_policy,
        out_of_scope_failure_detected: false,
        out_of_scope_audit_verdict: 'NOT_APPLICABLE',
        violations: [],
        warnings: [],
        cycle_binding: cycleBinding
    };
}

export function buildValidationResult(
    config: FullSuiteValidationConfig,
    exitCode: number,
    timedOut: boolean,
    outputLines: string[],
    outputArtifactPath: string | null,
    taskChangedFiles: string[],
    cycleBinding?: FullSuiteValidationCycleBinding,
    repoRoot?: string
): FullSuiteValidationResult {
    const passed = exitCode === 0 && !timedOut;
    const violations: string[] = [];
    const warnings: string[] = [];

    if (passed) {
        return {
            status: 'PASSED',
            enabled: true,
            command: config.command,
            placement: config.placement,
            exit_code: exitCode,
            timed_out: false,
            output_artifact_path: outputArtifactPath ? normalizePath(outputArtifactPath) : null,
            compact_summary: compactGreenSummary(outputLines, config.green_summary_max_lines),
            failure_chunks: [],
            out_of_scope_failure_policy: config.out_of_scope_failure_policy,
            out_of_scope_failure_detected: false,
            out_of_scope_audit_verdict: 'NOT_APPLICABLE',
            violations: [],
            warnings: [],
            cycle_binding: cycleBinding
        };
    }

    const failureChunks = compactRedFailureChunks(outputLines, config.red_failure_chunk_lines);
    const failureScope = inspectFailureScope(outputLines, taskChangedFiles, repoRoot);
    const outOfScopeDetected = failureScope.outside;
    const harnessFailure = detectHarnessTimeoutFailure(outputLines, taskChangedFiles, timedOut, failureScope);
    let auditVerdict: 'BLOCKED' | 'WARNED' | 'NOT_APPLICABLE' = 'NOT_APPLICABLE';
    if (outOfScopeDetected) {
        auditVerdict = harnessFailure.detected || config.out_of_scope_failure_policy === 'AUDIT_AND_WARN'
            ? 'WARNED'
            : 'BLOCKED';
    }

    const effectiveStatus: 'FAILED' | 'WARNED' =
        timedOut && config.timeout_blocker === false
            ? 'WARNED'
            : harnessFailure.detected
            ? 'WARNED'
            : outOfScopeDetected
            && !failureScope.inside && !failureScope.unresolved
            && config.out_of_scope_failure_policy === 'AUDIT_AND_WARN'
            && !timedOut
                ? 'WARNED'
                : 'FAILED';

    if (effectiveStatus === 'FAILED') {
        if (timedOut) {
            violations.push(`Full suite validation timed out after ${config.timeout_ms}ms.`);
        } else {
            violations.push(`Full suite validation failed with exit code ${exitCode}.`);
        }
        if (outOfScopeDetected && auditVerdict === 'BLOCKED') {
            violations.push(
                'Out-of-scope test failures detected. Policy AUDIT_AND_BLOCK requires resolution before DONE. ' +
                'Review the full output artifact for details.'
            );
        }
    } else {
        if (timedOut && config.timeout_blocker === false) {
            warnings.push(
                'Full suite validation timed out, but workflow-config.full_suite_validation.timeout_blocker=false. ' +
                'Recorded as WARNED so task progress can continue with explicit timeout-warning evidence.'
            );
            warnings.push(`Full suite exited with code ${exitCode} after timeout ${config.timeout_ms}ms.`);
        } else if (harnessFailure.detected) {
            warnings.push(
                'Full suite timed out in an out-of-scope test harness or lock surface. ' +
                'Recorded as WARNED so unrelated reviewed tasks are not blocked indefinitely. ' +
                'Review the full output artifact and fix the harness separately.'
            );
            warnings.push(`Harness failure reason: ${harnessFailure.reason}`);
            warnings.push(`Full suite exited with code ${exitCode} after timeout ${config.timeout_ms}ms.`);
        } else {
            warnings.push(
                'Out-of-scope test failures detected. Policy AUDIT_AND_WARN records the finding but does not block completion. ' +
                'Review the full output artifact for details.'
            );
            warnings.push(`Full suite exited with code ${exitCode} (non-blocking under AUDIT_AND_WARN).`);
        }
    }

    return {
        status: effectiveStatus,
        enabled: true,
        command: config.command,
        placement: config.placement,
        exit_code: exitCode,
        timed_out: timedOut,
        output_artifact_path: outputArtifactPath ? normalizePath(outputArtifactPath) : null,
        compact_summary: failureChunks.length > 0 ? failureChunks[0].slice(0, config.green_summary_max_lines) : [],
        failure_chunks: failureChunks,
        out_of_scope_failure_policy: config.out_of_scope_failure_policy,
        out_of_scope_failure_detected: outOfScopeDetected,
        out_of_scope_audit_verdict: auditVerdict,
        harness_failure_detected: harnessFailure.detected,
        harness_failure_audit_verdict: harnessFailure.detected ? 'WARNED' : 'NOT_APPLICABLE',
        harness_failure_reason: harnessFailure.reason,
        violations,
        warnings,
        cycle_binding: cycleBinding
    };
}

function failurePathKey(file: string): string {
    const normalized = normalizePath(file).replace(/^\.\//u, '');
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function inspectFailureScope(outputLines: string[], taskChangedFiles: string[], repoRoot?: string) {
    const result = { outside: false, inside: false, unresolved: false };
    if (!taskChangedFiles.length) return result;
    const changed = new Set(taskChangedFiles.map(failurePathKey));
    const references = collectFailureFileRefs(outputLines);
    result.unresolved = references.length > MAX_BOUNDARY_SOURCE_REFERENCES;
    for (const ref of references.slice(0, MAX_BOUNDARY_SOURCE_REFERENCES)) {
        let source = ref;
        if (repoRoot) {
            source = normalizePath(path.relative(path.resolve(repoRoot), path.resolve(repoRoot, ref)));
            if (source.startsWith('.node-build/')) {
                const mapped = resolveNodeFoundationFailureSource(repoRoot, source);
                if (!mapped) { result.unresolved = true; continue; }
                source = mapped;
            }
        }
        if (changed.has(failurePathKey(source))) result.inside = true;
        else result.outside = true;
    }
    return result;
}

export function detectOutOfScopeFailures(outputLines: string[], taskChangedFiles: string[], repoRoot?: string): boolean {
    return inspectFailureScope(outputLines, taskChangedFiles, repoRoot).outside;
}

function collectFailureFileRefs(outputLines: string[]): string[] {
    const failureFileRefs: string[] = [];

    for (const line of outputLines) {
        // A launcher reports the failed invocation, not the source owning an assertion.
        if (/\bCommand failed:/iu.test(line)) continue;
        const testLocation = /^\s*test at (.+?):\d+(?::\d+)?\s*$/u.exec(line);
        if (testLocation) { failureFileRefs.push(normalizePath(testLocation[1])); continue; }
        if (!/\bfail(ed|ure|ing)?\b/i.test(line) && !/\berror\b/i.test(line) && !/\bnot ok\b/i.test(line)) {
            continue;
        }
        const fileRefMatch = line.match(/\b(?:at|in|file)\s+(.+?):\d+(?::\d+)?(?:\s|$)/u)
            ?? line.match(/(?:at\s+|in\s+|file\s+)?([^\s:()[\]]+\.[^\s:()[\]]+)[\s:(\]]/u);
        if (fileRefMatch) {
            failureFileRefs.push(normalizePath(fileRefMatch[1]));
        }
    }

    return [...new Set(failureFileRefs)];
}

function detectHarnessTimeoutFailure(
    outputLines: string[],
    taskChangedFiles: string[],
    timedOut: boolean,
    scope: ReturnType<typeof inspectFailureScope>
): { detected: boolean; reason: string | null; } {
    if (!timedOut || taskChangedFiles.length === 0) {
        return { detected: false, reason: null };
    }

    const joinedOutput = outputLines.join('\n');
    const hasHarnessSignal =
        /Process timed out after \d+ ms\./i.test(joinedOutput)
        && (
            /Timed out acquiring file lock:/i.test(joinedOutput)
            || /task-event append failed/i.test(joinedOutput)
            || /\.scripts-build\.lock|\.node-build\.lock|dist\.lock/i.test(joinedOutput)
            || /cli[\\/]+commands[\\/]+gates/i.test(joinedOutput)
        );
    if (!hasHarnessSignal) {
        return { detected: false, reason: null };
    }

    const failureFileRefs = collectFailureFileRefs(outputLines);
    if (failureFileRefs.length === 0) {
        return { detected: false, reason: null };
    }

    if (scope.inside || scope.unresolved || !scope.outside) {
        return { detected: false, reason: null };
    }

    return {
        detected: true,
        reason: 'timeout_with_out_of_scope_lock_or_cli_gates_harness_failures'
    };
}
