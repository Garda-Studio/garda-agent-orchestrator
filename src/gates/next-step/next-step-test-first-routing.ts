import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import * as path from 'node:path';

import { getCurrentIntermediateTestTargets, readReportedTestCases, observeNativeIntermediateScope } from '../../cli/commands/gate-flows/command-run/intermediate-command-scope';
import { readStagedBlobFingerprints } from '../../core/staged-index-fingerprints';
import { isPlainRecord } from '../../core/records';
import { inspectTaskEventFile } from '../../gate-runtime/task-events';
import {
    fileSha256,
    isPathRealpathInsideRoot,
    normalizePath,
    resolvePathInsideRepo
} from '../shared/helpers';
import {
    hasTestFirstExpectedRedDeclaration,
    TEST_FIRST_EXPECTED_RED_MARKER
} from '../test-first/test-first-declaration';
import { readOrderedTaskEvents } from '../task-audit/task-audit-summary-lifecycle';
import { inspectRecipeExpectedRedRoute } from '../project-validation/focused';
import { buildScopeContentFingerprint } from '../compile/compile-gate';
import { readTaskOwnedIntermediateExecutionEvidence, type NativeIntermediateExecutionEntry } from '../review/focused-intermediate-evidence';
import { buildCommand, quoteCommandValue } from './next-step-command-formatters';
import type { NextStepCommand } from './next-step';
import type { TaskQueueEntry } from './next-step-task-queue';
import { requiredExpectedRedFiles } from '../test-first/expected-red-scope';
import { currentExpectedRedExecutionEvidence } from '../test-first/expected-red-evidence';

const MAX_TIMELINE_BYTES = 2 * 1024 * 1024;
const MAX_TIMELINE_EVENTS = 1024;
const EXPECTED_FAILURE_EVENT = 'TEST_FIRST_EXPECTED_FAILURE_RECORDED';

export interface NextStepTestFirstExpectedFailureRoute {
    nextGate: 'test-first-expected-failure' | 'implementation';
    title: string;
    reason: string;
    commands: NextStepCommand[];
}

export interface TestFirstExpectedFailureRouteOptions {
    repoRoot: string;
    reviewsRoot: string;
    eventsRoot: string;
    taskId: string;
    taskEntry: TaskQueueEntry | null;
    preflight: Record<string, unknown> | null;
    preflightPath: string;
    preflightCommandPath: string;
    cliPrefix: string;
    workspaceReady: boolean;
    currentChangedFiles?: readonly string[] | null;
}

function normalizeFileList(values: readonly unknown[]): string[] {
    return [...new Set(
        values
            .map((entry) => normalizePath(String(entry || '').trim()).replace(/^\.\/?/u, ''))
            .filter(Boolean)
    )].sort();
}

function sameStringList(left: readonly string[], right: readonly string[]): boolean {
    return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

function resolveRequiredReviewArtifact(
    artifactPathText: string,
    repoRoot: string,
    reviewsRoot: string
): string | null {
    try {
        const artifactPath = resolvePathInsideRepo(artifactPathText, repoRoot, {
            allowMissing: false,
            enforceInside: true
        });
        return artifactPath && isPathRealpathInsideRoot(artifactPath, reviewsRoot)
            ? artifactPath
            : null;
    } catch {
        return null;
    }
}

function getTaskSequence(event: Record<string, unknown>): number | null {
    const integrity = isPlainRecord(event.integrity) ? event.integrity : {};
    const sequence = integrity.task_sequence;
    return typeof sequence === 'number' && Number.isInteger(sequence) && sequence >= 0
        ? sequence
        : null;
}

function inspectNativeExpectedFailureProgress(options: TestFirstExpectedFailureRouteOptions): 'implementation' | 'complete' | null {
    const preflightSha256 = fileSha256(options.preflightPath);
    const preflightMetrics = isPlainRecord(options.preflight?.metrics) ? options.preflight.metrics : {};
    const testScopeSha256 = String(
        preflightMetrics.scope_content_sha256 || preflightMetrics.scope_sha256 || ''
    ).trim().toLowerCase();
    if (!preflightSha256 || !/^[0-9a-f]{64}$/u.test(testScopeSha256)) {
        return null;
    }
    const nativeScope = observeNativeIntermediateScope(options.repoRoot, options.taskId, options.preflightPath);
    if (nativeScope.preflight_sha256 !== preflightSha256 || nativeScope.scope_content_sha256 !== testScopeSha256) return null;
    const timelinePath = path.join(options.eventsRoot, `${options.taskId}.jsonl`);
    try {
        const timelineStat = fs.statSync(timelinePath);
        if (!timelineStat.isFile() || timelineStat.size > MAX_TIMELINE_BYTES) {
            return null;
        }
    } catch {
        return null;
    }
    const inspection = inspectTaskEventFile(timelinePath, options.taskId);
    if (inspection.status !== 'PASS' && inspection.status !== 'PASS_WITH_LEGACY_PREFIX') {
        return null;
    }
    const events = readOrderedTaskEvents(timelinePath).events;
    if (events.length > MAX_TIMELINE_EVENTS) {
        return null;
    }
    const latestTaskModeSequence = events.reduce<number | null>((latest, event) => {
        if (String(event.event_type || '').trim() !== 'TASK_MODE_ENTERED') {
            return latest;
        }
        const sequence = getTaskSequence(event);
        return sequence == null || (latest != null && latest >= sequence) ? latest : sequence;
    }, null);
    if (latestTaskModeSequence == null) {
        return null;
    }
    const changedFiles = new Set(normalizeFileList(
        Array.isArray(options.preflight?.changed_files) ? options.preflight.changed_files : []
    ));
    const detectionSource = String(options.preflight?.detection_source || 'explicit_changed_files');
    const staged = ['git_staged_only', 'git_staged_plus_untracked'].includes(detectionSource)
        ? readStagedBlobFingerprints(options.repoRoot, [...changedFiles]) : undefined;
    let greenEntries: NativeIntermediateExecutionEntry[] | undefined;
    const latestCommandSequence = new Map<string, number>();
    for (const event of events) {
        if (event.event_type !== 'INTERMEDIATE_COMMAND_RUN' && event.event_type !== EXPECTED_FAILURE_EVENT) continue;
        const details = isPlainRecord(event.details) ? event.details : {};
        latestCommandSequence.set(JSON.stringify([details.command_source, details.command]), getTaskSequence(event) ?? -1);
    }
    let hasCurrentRed = false;
    for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        if (String(event.event_type || '').trim() !== EXPECTED_FAILURE_EVENT) {
            continue;
        }
        const sequence = getTaskSequence(event);
        const details = isPlainRecord(event.details) ? event.details : {};
        const artifactPathText = String(details.artifact_path || '').trim();
        const artifactSha256 = String(details.artifact_sha256 || '').trim().toLowerCase();
        if (
            String(event.task_id || '').trim() !== options.taskId
            || sequence == null
            || sequence <= latestTaskModeSequence
            || !['PASS', 'PASSED'].includes(String(event.outcome || '').trim().toUpperCase())
            || details.expected_failure !== true
            || String(details.recorded_status || '').trim() !== 'EXPECTED_FAILURE'
            || details.timed_out === true
            || details.cancelled === true
            || !/^[0-9a-f]{64}$/u.test(artifactSha256)
        ) {
            continue;
        }
        const artifactPath = resolveRequiredReviewArtifact(
            artifactPathText,
            options.repoRoot,
            options.reviewsRoot
        );
        if (!artifactPath || fileSha256(artifactPath) !== artifactSha256) {
            continue;
        }
        let record: Record<string, unknown>;
        try {
            const parsed = JSON.parse(fs.readFileSync(artifactPath, 'utf8')) as unknown;
            if (!isPlainRecord(parsed)) {
                continue;
            }
            record = parsed;
        } catch {
            continue;
        }
        const commandSource = String(record.command_source || '').trim();
        const command = String(record.command || '').trim();
        const redPreflightSha256 = String(record.preflight_sha256 || '').trim().toLowerCase();
        const redScopeSha256 = String(record.test_scope_sha256 || '').trim().toLowerCase();
        const recordPreflightPath = normalizePath(String(record.preflight_path || '').trim());
        const outputArtifactPathText = String(record.output_artifact || '').trim();
        const outputArtifactSha256 = String(record.output_artifact_sha256 || '').trim().toLowerCase();
        const outputArtifactSizeBytes = record.output_artifact_size_bytes;
        const outputArtifactPath = resolveRequiredReviewArtifact(
            outputArtifactPathText,
            options.repoRoot,
            options.reviewsRoot
        );
        if (
            record.schema_version !== 1
            || String(record.task_id || '').trim() !== options.taskId
            || record.expected_failure !== true
            || String(record.status || '').trim() !== 'EXPECTED_FAILURE'
            || typeof record.exit_code !== 'number'
            || !Number.isInteger(record.exit_code)
            || record.exit_code === 0
            || record.timed_out === true
            || record.cancelled === true
            || recordPreflightPath !== normalizePath(options.preflightPath)
            || !/^[0-9a-f]{64}$/u.test(redPreflightSha256)
            || !/^[0-9a-f]{64}$/u.test(redScopeSha256)
            || String(details.preflight_sha256 || '').trim().toLowerCase() !== redPreflightSha256
            || String(details.test_scope_sha256 || '').trim().toLowerCase() !== redScopeSha256
            || String(details.command_source || '').trim() !== commandSource
            || String(details.command || '').trim() !== command
            || details.exit_code !== record.exit_code
            || !['node-test', 'targeted-test'].includes(commandSource)
            || record.scope_content_sha256_before !== redScopeSha256
            || record.scope_content_sha256_after !== redScopeSha256
            || details.scope_content_sha256_before !== redScopeSha256
            || details.scope_content_sha256_after !== redScopeSha256
            || !outputArtifactPath
            || !/^[0-9a-f]{64}$/u.test(outputArtifactSha256)
            || typeof outputArtifactSizeBytes !== 'number'
            || !Number.isSafeInteger(outputArtifactSizeBytes)
            || outputArtifactSizeBytes < 0
        ) {
            continue;
        }
        const focusedTestPaths = getCurrentIntermediateTestTargets(
            options.repoRoot, command,
            [...changedFiles]
        );
        if (!focusedTestPaths.some((testPath) => changedFiles.has(testPath))
            || !requiredExpectedRedFiles(options.preflight || {}, options.repoRoot)
                .every(file => typeof file === 'string' && focusedTestPaths.includes(file))) {
            continue;
        }
        try {
            const output = fs.readFileSync(outputArtifactPath);
            const redCases = readReportedTestCases(output.toString('utf8'));
            if (
                output.length !== outputArtifactSizeBytes
                || createHash('sha256').update(output).digest('hex') !== outputArtifactSha256
                || !redCases?.some(item => item.outcome === 'failed')
                || redCases.some(item => item.outcome === 'skipped')
                || String(details.output_artifact_sha256 || '').trim().toLowerCase() !== outputArtifactSha256
                || details.output_artifact_size_bytes !== outputArtifactSizeBytes
                || resolveRequiredReviewArtifact(
                    String(details.output_artifact_path || '').trim(),
                    options.repoRoot,
                    options.reviewsRoot
                ) !== outputArtifactPath
            ) {
                continue;
            }
            const currentRed = redPreflightSha256 === preflightSha256 && redScopeSha256 === testScopeSha256;
            // Historical RED is usable only when its exact tested bytes can be reconstructed.
            if (!currentRed && buildScopeContentFingerprint(options.repoRoot, detectionSource, focusedTestPaths, staged) !== redScopeSha256) continue;
            greenEntries ??= readTaskOwnedIntermediateExecutionEvidence({
                repoRoot: options.repoRoot, reviewsRoot: options.reviewsRoot, eventsRoot: options.eventsRoot,
                taskId: options.taskId, expectedPreflightPath: options.preflightPath,
                maxEntries: events.length, maxIntermediateCandidatesScanned: events.length,
                expectedPreflightSha256: preflightSha256, expectedScopeContentSha256: testScopeSha256
            }).entries;
            for (const green of greenEntries) {
                if (green.command !== command || green.command_source !== commandSource
                    || green.event_task_sequence <= sequence
                    || green.event_task_sequence !== latestCommandSequence.get(JSON.stringify([commandSource, command]))) continue;
                const greenOutput = fs.readFileSync(green.output_artifact_path);
                if (greenOutput.length !== green.output_artifact_size_bytes
                    || createHash('sha256').update(greenOutput).digest('hex') !== green.output_artifact_sha256) continue;
                const greenCases = readReportedTestCases(greenOutput.toString('utf8'));
                if (greenCases?.length === redCases.length && greenCases.every(item => item.outcome === 'passed'
                    && redCases.some(red => red.id === item.id))) return 'complete';
            }
            hasCurrentRed ||= currentRed;
        } catch {
            continue;
        }
    }
    return hasCurrentRed ? 'implementation' : null;
}

export function buildTestFirstExpectedFailureRoute(
    options: TestFirstExpectedFailureRouteOptions
): NextStepTestFirstExpectedFailureRoute | null {
    if (
        !options.preflight
        || !hasTestFirstExpectedRedDeclaration(options.taskEntry)
        || String(options.preflight.task_id || '').trim() !== options.taskId
        || String(options.preflight.scope_category || '').trim().toLowerCase() !== 'test-only'
        || !options.workspaceReady
    ) {
        return null;
    }
    const preflightChangedFiles = normalizeFileList(
        Array.isArray(options.preflight.changed_files) ? options.preflight.changed_files : []
    );
    const currentChangedFiles = normalizeFileList(options.currentChangedFiles || preflightChangedFiles);
    if (!sameStringList(preflightChangedFiles, currentChangedFiles)) {
        return null;
    }
    const recipeRoute = inspectRecipeExpectedRedRoute({ repoRoot: options.repoRoot, taskId: options.taskId,
        preflight: options.preflight, preflightSha256: fileSha256(options.preflightPath) });
    if (recipeRoute) {
        return {
            nextGate: recipeRoute.expectedFailure ? 'implementation' : 'test-first-expected-failure',
            title: recipeRoute.expectedFailure ? 'Implement the behavior after retaining the declared recipe failure.'
                : 'Record genuine expected-red evidence from the admitted recipe.',
            reason: recipeRoute.violation ?? (recipeRoute.expectedFailure
                ? 'Native evidence retains the declared targets and complete nonzero execution. The ordinary post-implementation review must verify assertion semantics alongside current GREEN.'
                : 'TASK.md declares expected red. Run the current admitted recipe; unexpected pass, interrupted execution and superseded evidence cannot advance implementation.'),
            commands: recipeRoute.expectedFailure || recipeRoute.recipeIds.length === 0 ? [] : [buildCommand(
                'Record declared recipe expected-red failure', `${options.cliPrefix} gate run-intermediate-command`
                + ` --task-id ${quoteCommandValue(options.taskId)} --recipe-id ${quoteCommandValue(recipeRoute.recipeIds[0])}`
                + ' --expect-failure --repo-root "."')]
        };
    }
    // Source names do not establish a runnable command or its result reporter.
    const testPaths = normalizeFileList(Array.isArray(options.preflight.changed_files) ? options.preflight.changed_files : []);
    if (testPaths.length === 0) {
        return {
            nextGate: 'test-first-expected-failure',
            title: 'A runnable changed test is required for expected-red evidence.',
            reason:
                `TASK.md declares ${TEST_FIRST_EXPECTED_RED_MARKER}, but the current test-only preflight has no concrete changed source. `
                + 'Materialize and classify the intended test; compile and full-suite remain fail-closed.',
            commands: []
        };
    }
    const expectedRed = currentExpectedRedExecutionEvidence(options.repoRoot, options.taskId);
    if (expectedRed) {
        return { nextGate: 'implementation',
            title: 'Implement the behavior after retaining the current failing test execution.',
            reason: 'Native evidence retains the exact source, selected cases and actual nonzero execution. Assertion semantics remain pending the ordinary independent review after implementation. Preserve these test sources, obtain complete current GREEN, and let the existing review verify both executions before task acceptance.',
            commands: [] };
    }
    const nativeProgress = inspectNativeExpectedFailureProgress(options);
    if (nativeProgress === 'complete') return null;
    if (nativeProgress === 'implementation') {
        return {
            nextGate: 'implementation',
            title: 'Implement the behavior proved red by the focused test.',
            reason:
                'Current task-owned expected-red evidence is authenticated against the exact test-only preflight and output artifact. '
                + 'Implement the production change, then rerun next-step; scope drift will require refreshed preflight before normal compile, full-suite, reviews, and completion.',
            commands: []
        };
    }
    return {
        nextGate: 'test-first-expected-failure',
        title: 'Select the actual focused command and failed-case reporter.',
        reason:
            `TASK.md declares ${TEST_FIRST_EXPECTED_RED_MARKER}. No command or reporter is inferred from source names or build manifests. `
            + 'Use gate run-intermediate-command with --command-source targeted-test, the actual project --command, '
            + '--expect-failure and the current --preflight-path. Bind opaque selectors with --selected-case; retained output and exact source identities reach the ordinary independent review after implementation. '
            + 'Alternatively, declare the actual project command, target association and supported result format through an admitted recipe. '
            + 'Process failure alone cannot establish assertion semantics or final acceptance; current source and retained output authentication remain required.',
        commands: []
    };
}
