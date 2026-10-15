import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import * as path from 'node:path';

import { getCurrentIntermediateTestTargets, hasReportedFailedTestCase, observeNativeIntermediateScope } from '../../cli/commands/gate-flows/command-run/intermediate-command-scope';
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
import { buildCommand, quoteCommandValue } from './next-step-command-formatters';
import type { NextStepCommand } from './next-step';
import type { TaskQueueEntry } from './next-step-task-queue';

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

function hasCurrentExpectedFailureEvidence(options: TestFirstExpectedFailureRouteOptions): boolean {
    const preflightSha256 = fileSha256(options.preflightPath);
    const preflightMetrics = isPlainRecord(options.preflight?.metrics) ? options.preflight.metrics : {};
    const testScopeSha256 = String(
        preflightMetrics.scope_content_sha256 || preflightMetrics.scope_sha256 || ''
    ).trim().toLowerCase();
    if (!preflightSha256 || !/^[0-9a-f]{64}$/u.test(testScopeSha256)) {
        return false;
    }
    const nativeScope = observeNativeIntermediateScope(options.repoRoot, options.taskId, options.preflightPath);
    if (nativeScope.preflight_sha256 !== preflightSha256 || nativeScope.scope_content_sha256 !== testScopeSha256) return false;
    const timelinePath = path.join(options.eventsRoot, `${options.taskId}.jsonl`);
    try {
        const timelineStat = fs.statSync(timelinePath);
        if (!timelineStat.isFile() || timelineStat.size > MAX_TIMELINE_BYTES) {
            return false;
        }
    } catch {
        return false;
    }
    const inspection = inspectTaskEventFile(timelinePath, options.taskId);
    if (inspection.status !== 'PASS' && inspection.status !== 'PASS_WITH_LEGACY_PREFIX') {
        return false;
    }
    const events = readOrderedTaskEvents(timelinePath).events;
    if (events.length > MAX_TIMELINE_EVENTS) {
        return false;
    }
    const latestTaskModeSequence = events.reduce<number | null>((latest, event) => {
        if (String(event.event_type || '').trim() !== 'TASK_MODE_ENTERED') {
            return latest;
        }
        const sequence = getTaskSequence(event);
        return sequence == null || (latest != null && latest >= sequence) ? latest : sequence;
    }, null);
    if (latestTaskModeSequence == null) {
        return false;
    }
    const changedFiles = new Set(normalizeFileList(
        Array.isArray(options.preflight?.changed_files) ? options.preflight.changed_files : []
    ));
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
            || String(record.preflight_sha256 || '').trim().toLowerCase() !== preflightSha256
            || String(record.test_scope_sha256 || '').trim().toLowerCase() !== testScopeSha256
            || String(details.preflight_sha256 || '').trim().toLowerCase() !== preflightSha256
            || String(details.test_scope_sha256 || '').trim().toLowerCase() !== testScopeSha256
            || String(details.command_source || '').trim() !== commandSource
            || String(details.command || '').trim() !== command
            || details.exit_code !== record.exit_code
            || !['node-test', 'targeted-test'].includes(commandSource)
            || record.scope_content_sha256_before !== testScopeSha256
            || record.scope_content_sha256_after !== testScopeSha256
            || details.scope_content_sha256_before !== testScopeSha256
            || details.scope_content_sha256_after !== testScopeSha256
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
        if (!focusedTestPaths.some((testPath) => changedFiles.has(testPath))) {
            continue;
        }
        try {
            const output = fs.readFileSync(outputArtifactPath);
            if (
                output.length !== outputArtifactSizeBytes
                || createHash('sha256').update(output).digest('hex') !== outputArtifactSha256
                || !hasReportedFailedTestCase(output.toString('utf8'))
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
        } catch {
            continue;
        }
        return true;
    }
    return false;
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
            title: recipeRoute.expectedFailure ? 'Implement the behavior proved red by the declared recipe.'
                : 'Record genuine expected-red evidence from the admitted recipe.',
            reason: recipeRoute.violation ?? (recipeRoute.expectedFailure
                ? 'Current canonical EXPECTED_FAILURE evidence authenticates the declared target, task cycle and exact test-only preflight.'
                : 'TASK.md declares expected red. Run the current admitted recipe; unexpected pass, unresolved output and superseded evidence cannot advance implementation.'),
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
    if (hasCurrentExpectedFailureEvidence(options)) {
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
            + '--expect-failure and the current --preflight-path. The command must emit a complete TAP 13/14 report with an actual failed case. '
            + 'Alternatively, declare the actual project command, target association and supported result format through an admitted recipe. '
            + 'Process failure alone cannot advance implementation; current source and retained output authentication remain required.',
        commands: []
    };
}
