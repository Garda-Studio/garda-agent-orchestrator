import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { appendTaskEvent } from '../../../../src/gate-runtime/task-events';
import { readTaskOwnedFocusedIntermediateEvidence } from '../../../../src/gates/review/focused-intermediate-evidence';
import * as intermediateEvidence from '../../../../src/gates/review/focused-intermediate-evidence';
import { runClassifyChangeCommand } from '../../../../src/cli/commands/gates';
import { createTempRepo, initializeGitRepo, loadTaskEntryRulePack, runEnterTaskMode,
    runHandshakeForTask, runShellSmokeForTask, seedInitAnswers, seedTaskQueue } from '../../cli/commands/gates/preflight/gates-preflight-fixtures';

const TASK_ID = 'T-979-4';
const TEST_PATH = 'tests/node/gates/review/focused-intermediate-evidence.test.ts';

function sha256(filePath: string): string {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function makeFixture(): { repoRoot: string; bundleRoot: string; reviewsRoot: string; eventsRoot: string } {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-focused-evidence-'));
    const bundleRoot = path.join(repoRoot, 'garda-agent-orchestrator');
    const reviewsRoot = path.join(bundleRoot, 'runtime', 'reviews');
    const eventsRoot = path.join(bundleRoot, 'runtime', 'task-events');
    fs.mkdirSync(reviewsRoot, { recursive: true });
    fs.mkdirSync(eventsRoot, { recursive: true });
    return { repoRoot, bundleRoot, reviewsRoot, eventsRoot };
}

function nativeFixture() {
    const repoRoot = createTempRepo();
    seedTaskQueue(repoRoot, TASK_ID); seedInitAnswers(repoRoot); initializeGitRepo(repoRoot);
    const entry = runEnterTaskMode({ repoRoot, taskId: TASK_ID, entryMode: 'EXPLICIT_TASK_EXECUTION',
        requestedDepth: 2, taskSummary: 'Native execution evidence', provider: 'Codex' });
    assert.equal(entry.exitCode, 0, entry.outputLines.join('\n'));
    loadTaskEntryRulePack(repoRoot, TASK_ID);
    runHandshakeForTask(repoRoot, TASK_ID); runShellSmokeForTask(repoRoot, TASK_ID);
    fs.mkdirSync(path.join(repoRoot, 'custom'));
    fs.writeFileSync(path.join(repoRoot, 'custom/source.case'), 'opaque test source\n');
    const bundleRoot = path.join(repoRoot, 'garda-agent-orchestrator');
    const reviewsRoot = path.join(bundleRoot, 'runtime/reviews');
    const eventsRoot = path.join(bundleRoot, 'runtime/task-events');
    const preflightPath = path.join(reviewsRoot, 'preflight.json').replace(/\\/g, '/');
    const classified = runClassifyChangeCommand({ repoRoot, taskId: TASK_ID, taskIntent: 'Native execution evidence',
        changedFiles: ['custom/source.case'], outputPath: preflightPath });
    assert.ok(fs.existsSync(preflightPath), classified.outputText);
    const scopeContentSha256 = JSON.parse(fs.readFileSync(preflightPath, 'utf8')).metrics.scope_content_sha256 as string;
    return { repoRoot, bundleRoot, reviewsRoot, eventsRoot, preflightPath, preflightSha256: sha256(preflightPath), scopeContentSha256 };
}

function appendEvidence(options: {
    bundleRoot: string;
    reviewsRoot: string;
    taskId?: string;
    command?: string;
    status?: 'PASSED' | 'FAILED';
    mutateOutput?: boolean;
    artifactTaskId?: string;
    omitEventExitCode?: boolean;
    omitEventOutputArtifactPath?: boolean;
    preflightPath?: string;
    preflightSha256?: string;
    coverageContractSha256?: string;
    eventPreflightSha256?: string;
    scopeContentSha256?: string;
    afterScopeContentSha256?: string;
}): void {
    const taskId = options.taskId ?? TASK_ID;
    const command = options.command
        ?? `node scripts/node-foundation/build-scripts.cjs test.js ${TEST_PATH}`;
    const suffix = crypto.randomBytes(4).toString('hex');
    const outputPath = path.join(options.reviewsRoot, `${taskId}-${suffix}.log`);
    const artifactPath = path.join(options.reviewsRoot, `${taskId}-${suffix}.json`);
    const status = options.status ?? 'PASSED';
    fs.writeFileSync(outputPath, 'focused validation passed\n', 'utf8');
    const outputSha256 = sha256(outputPath);
    const outputSize = fs.statSync(outputPath).size;
    fs.writeFileSync(artifactPath, JSON.stringify({
        schema_version: 1,
        task_id: options.artifactTaskId ?? taskId,
        command_source: 'targeted-test',
        command,
        status,
        exit_code: status === 'PASSED' ? 0 : 1,
        timed_out: false,
        cancelled: false,
        output_artifact: outputPath,
        output_artifact_sha256: outputSha256,
        output_artifact_size_bytes: outputSize,
        ...(options.preflightPath ? { preflight_path: options.preflightPath } : {}),
        ...(options.preflightSha256 ? { preflight_sha256: options.preflightSha256 } : {}),
        ...(options.coverageContractSha256 ? { coverage_contract_sha256: options.coverageContractSha256 } : {}),
        ...(options.scopeContentSha256 ? {
            scope_content_sha256_before: options.scopeContentSha256,
            scope_content_sha256_after: options.afterScopeContentSha256 ?? options.scopeContentSha256
        } : {})
    }), 'utf8');
    const eventDetails: Record<string, unknown> = {
        command_source: 'targeted-test',
        command,
        artifact_path: artifactPath,
        artifact_sha256: sha256(artifactPath),
        output_artifact_sha256: outputSha256,
        output_artifact_size_bytes: outputSize
    };
    if (options.preflightPath) {
        eventDetails.preflight_path = options.preflightPath;
    }
    if (options.preflightSha256) {
        eventDetails.preflight_sha256 = options.eventPreflightSha256 ?? options.preflightSha256;
    }
    if (options.coverageContractSha256) {
        eventDetails.coverage_contract_sha256 = options.coverageContractSha256;
    }
    if (options.scopeContentSha256) {
        eventDetails.scope_content_sha256_before = options.scopeContentSha256;
        eventDetails.scope_content_sha256_after = options.afterScopeContentSha256 ?? options.scopeContentSha256;
    }
    if (!options.omitEventOutputArtifactPath) {
        eventDetails.output_artifact_path = outputPath;
    }
    if (!options.omitEventExitCode) {
        eventDetails.exit_code = status === 'PASSED' ? 0 : 1;
    }
    appendTaskEvent(options.bundleRoot, taskId, 'INTERMEDIATE_COMMAND_RUN', status, 'Focused command.', eventDetails);
    if (options.mutateOutput) {
        fs.appendFileSync(outputPath, 'tampered\n', 'utf8');
    }
}

describe('task-owned focused intermediate evidence', () => {
    it('round-trips Maven and Gradle selectors without requiring a literal test filename in argv', () => {
        const fixture = makeFixture();
        const source = 'component/src/test/java/shop/CheckoutTest.java';
        try {
            appendTaskEvent(fixture.bundleRoot, TASK_ID, 'TASK_MODE_ENTERED', 'PASS', 'Current cycle.', {});
            appendEvidence({ ...fixture, command: 'mvn -q -Dtest=shop.CheckoutTest test' });
            appendEvidence({ ...fixture, command: 'gradle test --tests shop.CheckoutTest --console=plain' });
            const result = readTaskOwnedFocusedIntermediateEvidence({ ...fixture, taskId: TASK_ID, changedFiles: [source] });
            assert.equal(result.entries.length, 2);
            assert.ok(result.entries.every(entry => entry.focused_test_paths.includes(source)));
        } finally { fs.rmSync(fixture.repoRoot, { recursive: true, force: true }); }
    });

    it('keeps unrelated JVM selectors outside the supplied source scope', () => {
        const fixture = makeFixture();
        try {
            appendTaskEvent(fixture.bundleRoot, TASK_ID, 'TASK_MODE_ENTERED', 'PASS', 'Current cycle.', {});
            appendEvidence({ ...fixture, command: 'mvn -q -Dtest=shop.OtherTest test' });
            const result = readTaskOwnedFocusedIntermediateEvidence({ ...fixture, taskId: TASK_ID,
                changedFiles: ['component/src/test/java/shop/CheckoutTest.java'] });
            assert.equal(result.entries.length, 0);
        } finally { fs.rmSync(fixture.repoRoot, { recursive: true, force: true }); }
    });

    it('authenticates an opaque native command as process evidence without claiming case success', () => {
        const fixture = nativeFixture();
        const { preflightPath, preflightSha256, scopeContentSha256 } = fixture;
        try {
            appendEvidence({ ...fixture, command: 'unfamiliar-runner --select "Оплата::rejectsEmpty"',
                preflightPath, preflightSha256, scopeContentSha256 });
            const read = (intermediateEvidence as unknown as { readTaskOwnedIntermediateExecutionEvidence:
                (options: Record<string, unknown>) => { entries: Array<Record<string, unknown>> } }).readTaskOwnedIntermediateExecutionEvidence;
            const result = read({ ...fixture, taskId: TASK_ID, expectedPreflightPath: preflightPath,
                expectedPreflightSha256: preflightSha256, expectedScopeContentSha256: scopeContentSha256 });
            assert.equal(result.entries.length, 1);
            assert.equal(result.entries[0].execution, 'OBSERVED');
            assert.equal(result.entries[0].semantic_status, 'PENDING_INDEPENDENT_REVIEW');
            assert.equal(result.entries[0].cases, undefined);
        } finally { fs.rmSync(fixture.repoRoot, { recursive: true, force: true }); }
    });

    it('rejects altered output and changed native source scope for opaque command evidence', () => {
        const fixture = nativeFixture();
        const { preflightPath, preflightSha256, scopeContentSha256 } = fixture;
        try {
            appendEvidence({ ...fixture, command: 'custom-runner --case selected', preflightPath,
                preflightSha256, scopeContentSha256, mutateOutput: true });
            appendEvidence({ ...fixture, command: 'custom-runner --case selected', preflightPath,
                preflightSha256, scopeContentSha256, afterScopeContentSha256: 'c'.repeat(64) });
            const read = (intermediateEvidence as unknown as { readTaskOwnedIntermediateExecutionEvidence:
                (options: Record<string, unknown>) => { entries: unknown[] } }).readTaskOwnedIntermediateExecutionEvidence;
            assert.equal(read({ ...fixture, taskId: TASK_ID, expectedPreflightPath: preflightPath,
                expectedPreflightSha256: preflightSha256, expectedScopeContentSha256: scopeContentSha256 }).entries.length, 0);
        } finally { fs.rmSync(fixture.repoRoot, { recursive: true, force: true }); }
    });

    it('rejects a fabricated preflight digest despite matching record and expected bindings', () => {
        const fixture = nativeFixture();
        const { preflightPath, scopeContentSha256 } = fixture;
        const fabricatedHash = 'a'.repeat(64);
        try {
            appendEvidence({ ...fixture, command: 'custom-runner --case selected', preflightPath,
                preflightSha256: fabricatedHash, scopeContentSha256 });
            const result = intermediateEvidence.readTaskOwnedIntermediateExecutionEvidence({ ...fixture,
                taskId: TASK_ID, expectedPreflightPath: preflightPath,
                expectedPreflightSha256: fabricatedHash, expectedScopeContentSha256: scopeContentSha256 });
            assert.equal(result.entries.length, 0);
            assert.ok(result.warnings.some(warning => /preflight/iu.test(warning)));
        } finally { fs.rmSync(fixture.repoRoot, { recursive: true, force: true }); }
    });

    it('selects only current-cycle, PASS, scope-matched evidence with bounded metadata', () => {
        const fixture = makeFixture();
        try {
            appendEvidence(fixture);
            appendTaskEvent(fixture.bundleRoot, TASK_ID, 'TASK_MODE_ENTERED', 'PASS', 'Current cycle.', {});
            for (let index = 0; index < 10; index += 1) {
                appendEvidence(fixture);
            }

            const selection = readTaskOwnedFocusedIntermediateEvidence({
                repoRoot: fixture.repoRoot,
                reviewsRoot: fixture.reviewsRoot,
                eventsRoot: fixture.eventsRoot,
                taskId: TASK_ID,
                changedFiles: [TEST_PATH],
                maxEntries: 3
            });

            assert.equal(selection.entries.length, 3);
            assert.equal(selection.truncated, true);
            assert.equal(selection.candidate_count, 11);
            assert.equal(selection.rejected_candidate_count, 1);
            assert.ok(selection.entries.every((entry) => entry.status === 'PASSED' && entry.exit_code === 0));
            assert.ok(selection.entries.every((entry) => entry.focused_test_paths.includes(TEST_PATH)));
            assert.ok(selection.warnings.some((warning) => warning.includes('stale or foreign task/cycle binding')));
        } finally {
            fs.rmSync(fixture.repoRoot, { recursive: true, force: true });
        }
    });

    it('rejects failed, foreign, scope-mismatched, and tampered evidence with actionable warnings', () => {
        const fixture = makeFixture();
        try {
            appendTaskEvent(fixture.bundleRoot, TASK_ID, 'TASK_MODE_ENTERED', 'PASS', 'Current cycle.', {});
            appendEvidence({ ...fixture, status: 'FAILED' });
            appendEvidence({ ...fixture, omitEventExitCode: true });
            appendEvidence({ ...fixture, omitEventOutputArtifactPath: true });
            appendEvidence({ ...fixture, artifactTaskId: 'T-FOREIGN' });
            appendEvidence({
                ...fixture,
                command: 'node scripts/node-foundation/build-scripts.cjs test.js tests/node/other.test.ts'
            });
            appendEvidence({ ...fixture, mutateOutput: true });

            const selection = readTaskOwnedFocusedIntermediateEvidence({
                repoRoot: fixture.repoRoot,
                reviewsRoot: fixture.reviewsRoot,
                eventsRoot: fixture.eventsRoot,
                taskId: TASK_ID,
                changedFiles: [TEST_PATH]
            });

            assert.equal(selection.entries.length, 0);
            assert.equal(selection.rejected_candidate_count, 6);
            assert.ok(selection.warnings.some((warning) => warning.includes('not a gate-owned PASSED command')));
            assert.ok(selection.warnings.some((warning) => warning.includes('binding is inconsistent')));
            assert.ok(selection.warnings.some((warning) => warning.includes('outside the current review scope')));
            assert.ok(selection.warnings.some((warning) => warning.includes('size or sha256')));
        } finally {
            fs.rmSync(fixture.repoRoot, { recursive: true, force: true });
        }
    });

    it('requires focused evidence to match expected preflight and coverage bindings when provided', () => {
        const fixture = makeFixture();
        const preflightPath = path.join(fixture.reviewsRoot, 'T-979-4-preflight.json').replace(/\\/g, '/');
        const preflightSha256 = 'a'.repeat(64);
        const coverageContractSha256 = 'b'.repeat(64);
        try {
            appendTaskEvent(fixture.bundleRoot, TASK_ID, 'TASK_MODE_ENTERED', 'PASS', 'Current cycle.', {});
            appendEvidence({
                ...fixture,
                preflightPath,
                preflightSha256: 'c'.repeat(64),
                coverageContractSha256
            });
            appendEvidence({
                ...fixture,
                preflightPath,
                preflightSha256,
                coverageContractSha256
            });

            const selection = readTaskOwnedFocusedIntermediateEvidence({
                repoRoot: fixture.repoRoot,
                reviewsRoot: fixture.reviewsRoot,
                eventsRoot: fixture.eventsRoot,
                taskId: TASK_ID,
                changedFiles: [TEST_PATH],
                expectedPreflightPath: preflightPath,
                expectedPreflightSha256: preflightSha256,
                expectedCoverageContractSha256: coverageContractSha256,
                maxEntries: 2
            });

            assert.equal(selection.entries.length, 1);
            assert.equal(selection.entries[0].preflight_sha256, preflightSha256);
            assert.equal(selection.entries[0].coverage_contract_sha256, coverageContractSha256);
            assert.equal(selection.rejected_candidate_count, 1);
            assert.ok(selection.warnings.some((warning) => warning.includes('does not match the current review context')));
        } finally {
            fs.rmSync(fixture.repoRoot, { recursive: true, force: true });
        }
    });

    it('rejects focused evidence when event and artifact scope bindings disagree', () => {
        const fixture = makeFixture();
        try {
            appendTaskEvent(fixture.bundleRoot, TASK_ID, 'TASK_MODE_ENTERED', 'PASS', 'Current cycle.', {});
            appendEvidence({
                ...fixture,
                preflightPath: path.join(fixture.reviewsRoot, 'T-979-4-preflight.json').replace(/\\/g, '/'),
                preflightSha256: 'a'.repeat(64),
                eventPreflightSha256: 'b'.repeat(64),
                coverageContractSha256: 'c'.repeat(64)
            });

            const selection = readTaskOwnedFocusedIntermediateEvidence({
                repoRoot: fixture.repoRoot,
                reviewsRoot: fixture.reviewsRoot,
                eventsRoot: fixture.eventsRoot,
                taskId: TASK_ID,
                changedFiles: [TEST_PATH]
            });

            assert.equal(selection.entries.length, 0);
            assert.equal(selection.rejected_candidate_count, 1);
            assert.ok(selection.warnings.some((warning) => warning.includes('artifact and event preflight')));
        } finally {
            fs.rmSync(fixture.repoRoot, { recursive: true, force: true });
        }
    });

    it('rejects malformed focused evidence hash bindings even without expected bindings', () => {
        const fixture = makeFixture();
        try {
            appendTaskEvent(fixture.bundleRoot, TASK_ID, 'TASK_MODE_ENTERED', 'PASS', 'Current cycle.', {});
            appendEvidence({
                ...fixture,
                preflightPath: path.join(fixture.reviewsRoot, 'T-979-4-preflight.json').replace(/\\/g, '/'),
                preflightSha256: 'not-a-sha256',
                coverageContractSha256: 'b'.repeat(64)
            });

            const selection = readTaskOwnedFocusedIntermediateEvidence({
                repoRoot: fixture.repoRoot,
                reviewsRoot: fixture.reviewsRoot,
                eventsRoot: fixture.eventsRoot,
                taskId: TASK_ID,
                changedFiles: [TEST_PATH]
            });

            assert.equal(selection.entries.length, 0);
            assert.equal(selection.rejected_candidate_count, 1);
            assert.ok(selection.warnings.some((warning) => warning.includes('not a valid SHA-256 hex binding')));
        } finally {
            fs.rmSync(fixture.repoRoot, { recursive: true, force: true });
        }
    });

    it('does not bind surplus focused artifacts after the entry limit is reached', () => {
        const fixture = makeFixture();
        try {
            appendTaskEvent(fixture.bundleRoot, TASK_ID, 'TASK_MODE_ENTERED', 'PASS', 'Current cycle.', {});
            appendEvidence({ ...fixture, mutateOutput: true });
            for (let index = 0; index < 10; index += 1) {
                appendEvidence(fixture);
            }

            const selection = readTaskOwnedFocusedIntermediateEvidence({
                repoRoot: fixture.repoRoot,
                reviewsRoot: fixture.reviewsRoot,
                eventsRoot: fixture.eventsRoot,
                taskId: TASK_ID,
                changedFiles: [TEST_PATH],
                maxEntries: 3
            });

            assert.equal(selection.entries.length, 3);
            assert.equal(selection.candidate_count, 11);
            assert.equal(selection.rejected_candidate_count, 0);
            assert.equal(selection.truncated, true);
            assert.equal(selection.warnings.some((warning) => warning.includes('size or sha256')), false);
        } finally {
            fs.rmSync(fixture.repoRoot, { recursive: true, force: true });
        }
    });

    it('rejects focused evidence when the task timeline exceeds bounded read limits', () => {
        const fixture = makeFixture();
        try {
            appendTaskEvent(fixture.bundleRoot, TASK_ID, 'TASK_MODE_ENTERED', 'PASS', 'Current cycle.', {});
            appendEvidence(fixture);

            const byteBoundSelection = readTaskOwnedFocusedIntermediateEvidence({
                repoRoot: fixture.repoRoot,
                reviewsRoot: fixture.reviewsRoot,
                eventsRoot: fixture.eventsRoot,
                taskId: TASK_ID,
                changedFiles: [TEST_PATH],
                maxTimelineBytes: 1
            });

            assert.equal(byteBoundSelection.entries.length, 0);
            assert.equal(byteBoundSelection.truncated, true);
            assert.ok(byteBoundSelection.warnings.some((warning) => warning.includes('byte read bound')));

            const eventBoundSelection = readTaskOwnedFocusedIntermediateEvidence({
                repoRoot: fixture.repoRoot,
                reviewsRoot: fixture.reviewsRoot,
                eventsRoot: fixture.eventsRoot,
                taskId: TASK_ID,
                changedFiles: [TEST_PATH],
                maxTimelineEvents: 1
            });

            assert.equal(eventBoundSelection.entries.length, 0);
            assert.equal(eventBoundSelection.truncated, true);
            assert.ok(eventBoundSelection.warnings.some((warning) => warning.includes('event read bound')));
        } finally {
            fs.rmSync(fixture.repoRoot, { recursive: true, force: true });
        }
    });

    it('caps intermediate candidate scanning even when more surplus evidence exists', () => {
        const fixture = makeFixture();
        try {
            appendTaskEvent(fixture.bundleRoot, TASK_ID, 'TASK_MODE_ENTERED', 'PASS', 'Current cycle.', {});
            for (let index = 0; index < 8; index += 1) {
                appendEvidence(fixture);
            }

            const selection = readTaskOwnedFocusedIntermediateEvidence({
                repoRoot: fixture.repoRoot,
                reviewsRoot: fixture.reviewsRoot,
                eventsRoot: fixture.eventsRoot,
                taskId: TASK_ID,
                changedFiles: [TEST_PATH],
                maxEntries: 3,
                maxIntermediateCandidatesScanned: 4
            });

            assert.equal(selection.entries.length, 3);
            assert.equal(selection.candidate_count, 4);
            assert.equal(selection.truncated, true);
            assert.ok(selection.warnings.some((warning) => warning.includes('surplus scan stopped after 4 intermediate candidates')));
        } finally {
            fs.rmSync(fixture.repoRoot, { recursive: true, force: true });
        }
    });
});
