import * as fs from 'node:fs';
import * as path from 'node:path';

import { splitCommandLine } from '../../cli/gate-cli/gates-subprocess';
import { isPlainRecord } from '../../core/records';
import { inspectTaskEventFile } from '../../gate-runtime/task-events';
import {
    getChangedTestPathsTargetedByCommandTokens,
    getDotnetFocusedClassTarget,
    getGoFocusedPackageTarget,
    getJvmFocusedTestSelector,
    getRustFocusedIntegrationTarget,
    isSafeFocusedTestPath,
    isFocusedIntermediateCommand
} from '../shared/focused-intermediate-command-grammar';
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

function getRunnableChangedTestPaths(preflight: Record<string, unknown>): string[] {
    return normalizeFileList(Array.isArray(preflight.changed_files) ? preflight.changed_files : [])
        .filter(isSafeFocusedTestPath);
}

function hasRootFile(repoRoot: string, names: readonly string[]): boolean {
    return names.some((name) => fs.existsSync(path.join(repoRoot, name)));
}

function hasRootFileExtension(repoRoot: string, extensions: readonly string[]): boolean {
    try {
        return fs.readdirSync(repoRoot, { withFileTypes: true })
            .some((entry) => entry.isFile() && extensions.includes(path.extname(entry.name).toLowerCase()));
    } catch {
        return false;
    }
}

function resolveJvmTool(repoRoot: string, kind: 'maven' | 'gradle'): string {
    const windows = process.platform === 'win32';
    if (kind === 'maven') {
        if (windows && fs.existsSync(path.join(repoRoot, 'mvnw.cmd'))) return '.\\mvnw.cmd';
        if (fs.existsSync(path.join(repoRoot, 'mvnw'))) return './mvnw';
        if (fs.existsSync(path.join(repoRoot, 'mvnw.cmd'))) return '.\\mvnw.cmd';
        return 'mvn';
    }
    if (windows && fs.existsSync(path.join(repoRoot, 'gradlew.bat'))) return '.\\gradlew.bat';
    if (fs.existsSync(path.join(repoRoot, 'gradlew'))) return './gradlew';
    if (fs.existsSync(path.join(repoRoot, 'gradlew.bat'))) return '.\\gradlew.bat';
    return 'gradle';
}

function buildFocusedTestCommand(repoRoot: string, testPaths: readonly string[]): {
    commandSource: 'node-test' | 'targeted-test';
    command: string;
} | null {
    for (const testPath of testPaths) {
        const quotedPath = quoteCommandValue(testPath);
        if (/\.(?:test|spec)\.(?:c|m)?[jt]sx?$/iu.test(testPath)) {
            if (fs.existsSync(path.join(repoRoot, 'scripts', 'node-foundation', 'build-scripts.cjs'))) {
                return {
                    commandSource: 'targeted-test',
                    command: `node scripts/node-foundation/build-scripts.cjs test.js ${quotedPath}`
                };
            }
            if (fs.existsSync(path.join(repoRoot, 'package.json'))) {
                return { commandSource: 'targeted-test', command: `npm test -- ${quotedPath}` };
            }
            return { commandSource: 'node-test', command: `node --test ${quotedPath}` };
        }
        if (/\.py$/iu.test(testPath) && hasRootFile(repoRoot, ['pyproject.toml', 'requirements.txt', 'requirements-dev.txt'])) {
            return { commandSource: 'targeted-test', command: `pytest ${quotedPath}` };
        }
        const jvmSelector = getJvmFocusedTestSelector(testPath);
        if (jvmSelector && fs.existsSync(path.join(repoRoot, 'pom.xml'))) {
            return {
                commandSource: 'targeted-test',
                command: `${resolveJvmTool(repoRoot, 'maven')} -q -Dtest=${jvmSelector} test`
            };
        }
        if (jvmSelector && hasRootFile(repoRoot, ['build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts'])) {
            return {
                commandSource: 'targeted-test',
                command: `${resolveJvmTool(repoRoot, 'gradle')} test --tests ${jvmSelector} --console=plain`
            };
        }
        const goTarget = getGoFocusedPackageTarget(testPath);
        if (goTarget && fs.existsSync(path.join(repoRoot, 'go.mod'))) {
            return { commandSource: 'targeted-test', command: `go test ${goTarget}` };
        }
        const rustTarget = getRustFocusedIntegrationTarget(testPath);
        if (rustTarget && fs.existsSync(path.join(repoRoot, 'Cargo.toml'))) {
            return { commandSource: 'targeted-test', command: `cargo test --test ${rustTarget}` };
        }
        const dotnetTarget = getDotnetFocusedClassTarget(testPath);
        if (dotnetTarget && hasRootFileExtension(repoRoot, ['.sln', '.csproj', '.fsproj'])) {
            return {
                commandSource: 'targeted-test',
                command: `dotnet test --filter FullyQualifiedName~${dotnetTarget} --verbosity quiet`
            };
        }
        if (/\.rb$/iu.test(testPath) && fs.existsSync(path.join(repoRoot, 'Gemfile'))) {
            return { commandSource: 'targeted-test', command: `bundle exec rspec ${quotedPath}` };
        }
        if (/\.php$/iu.test(testPath) && fs.existsSync(path.join(repoRoot, 'composer.json'))) {
            const phpUnit = fs.existsSync(path.join(repoRoot, 'vendor', 'bin', 'phpunit'))
                ? 'vendor/bin/phpunit'
                : 'phpunit';
            return { commandSource: 'targeted-test', command: `${phpUnit} ${quotedPath}` };
        }
    }
    return null;
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
            || !isFocusedIntermediateCommand(commandSource, splitCommandLine(command))
            || !outputArtifactPath
            || !/^[0-9a-f]{64}$/u.test(outputArtifactSha256)
            || typeof outputArtifactSizeBytes !== 'number'
            || !Number.isSafeInteger(outputArtifactSizeBytes)
            || outputArtifactSizeBytes < 0
        ) {
            continue;
        }
        const commandTokens = splitCommandLine(command);
        const focusedTestPaths = getChangedTestPathsTargetedByCommandTokens(
            commandTokens,
            [...changedFiles]
        );
        if (!focusedTestPaths.some((testPath) => changedFiles.has(testPath))) {
            continue;
        }
        try {
            if (
                fs.statSync(outputArtifactPath).size !== outputArtifactSizeBytes
                || fileSha256(outputArtifactPath) !== outputArtifactSha256
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
    const testPaths = getRunnableChangedTestPaths(options.preflight);
    if (testPaths.length === 0) {
        return {
            nextGate: 'test-first-expected-failure',
            title: 'A runnable changed test is required for expected-red evidence.',
            reason:
                `TASK.md declares ${TEST_FIRST_EXPECTED_RED_MARKER}, but the current test-only preflight does not include a supported concrete test file. `
                + 'Add the focused test file or remove the marker; compile and full-suite remain fail-closed.',
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
    const focusedCommand = buildFocusedTestCommand(options.repoRoot, testPaths);
    if (!focusedCommand) {
        return {
            nextGate: 'test-first-expected-failure',
            title: 'A runnable changed test is required for expected-red evidence.',
            reason:
                `TASK.md declares ${TEST_FIRST_EXPECTED_RED_MARKER}, but Garda cannot derive a bounded focused command for the current changed test and detected project runner. `
                + 'Add a supported runnable test or remove the marker; compile and full-suite remain fail-closed.',
            commands: []
        };
    }
    const command = [
        `${options.cliPrefix} gate run-intermediate-command`,
        `--task-id ${quoteCommandValue(options.taskId)}`,
        `--command-source ${quoteCommandValue(focusedCommand.commandSource)}`,
        `--command ${quoteCommandValue(focusedCommand.command)}`,
        '--expect-failure',
        `--preflight-path ${quoteCommandValue(options.preflightCommandPath)}`,
        '--repo-root "."'
    ].join(' ');
    return {
        nextGate: 'test-first-expected-failure',
        title: 'Record the bounded expected-red test failure.',
        reason:
            `TASK.md explicitly declares ${TEST_FIRST_EXPECTED_RED_MARKER} and the current scope is test-only. `
            + 'Run the focused changed test through the guarded expected-failure mode before implementation; an unexpected pass, timeout, cancellation, unrelated test, or stale evidence fails closed.',
        commands: [buildCommand('Record bounded expected-red failure', command)]
    };
}
