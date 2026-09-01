import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as childProcess from 'node:child_process';

import {
    EXIT_GATE_FAILURE
} from '../../../../../../src/cli/exit-codes';
import { runBuildReviewContextCommand } from '../../../../../../src/cli/commands/gate-build-handlers';
import {
    runCompileGateCommand,
    runDocImpactGateCommand,
    runRequiredReviewsCheckCommand
} from '../../../../../../src/cli/commands/gates';
import {
    runCliMainWithHandling
} from '../../../../../../src/cli/main';
import { validateReviewSkillEvidence } from '../../../../../../src/gates/completion';
import { getWorkspaceSnapshot } from '../../../../../../src/gates/compile/compile-gate';
import { buildReviewContext } from '../../../../../../src/gates/review-context/build-review-context';
import { buildScopedDiff } from '../../../../../../src/gates/preflight/build-scoped-diff';
import { applyReviewerRoutingMetadata } from '../../../../../../src/gate-runtime/review-context';
import {
    computeCodeReviewScopeFingerprint,
    computeReviewContextReuseHash,
    computeReviewReuseCodeScopeFingerprint,
    computeReviewRelevantScopeFingerprint,
    isNonTestReviewScope,
    resolveReviewContextReuseContractBindings
} from '../../../../../../src/gates/review-reuse';
import {
    appendTaskEvent,
    buildEventIntegrityHash
} from '../../../../../../src/gate-runtime/task-events';
import {
    createTempRepo,
    findLastTimelineEventIndex,
    getOrchestratorRoot,
    getReviewsRoot,
    initializeGitRepo,
    loadPostPreflightRulePack,
    loadTaskEntryRulePack,
    readTaskTimelineEvents,
    runEnterTaskMode,
    runExplicitPreflight,
    runHandshakeForTask,
    runShellSmokeForTask,
    resolveReviewerExecutionFixture,
    seedInitAnswers,
    seedReusableReviewEvidence,
    seedTaskQueue,
    writeCompilePassEvidence,
    writeHandshakeArtifact,
    writePreflight,
    writeReceiptBackedReviewArtifact,
    writeReviewCapabilitiesConfig,
    writeShellSmokeArtifact,
    appendPreflightClassifiedEvent,
    runGit
} from '../../gate-test-helpers';

export {
    describe,
    it,
    assert,
    fs,
    os,
    path,
    childProcess,
    EXIT_GATE_FAILURE,
    runBuildReviewContextCommand,
    runCompileGateCommand,
    runDocImpactGateCommand,
    runRequiredReviewsCheckCommand,
    runCliMainWithHandling,
    validateReviewSkillEvidence,
    getWorkspaceSnapshot,
    buildReviewContext,
    buildScopedDiff,
    applyReviewerRoutingMetadata,
    computeCodeReviewScopeFingerprint,
    computeReviewContextReuseHash,
    computeReviewReuseCodeScopeFingerprint,
    computeReviewRelevantScopeFingerprint,
    isNonTestReviewScope,
    resolveReviewContextReuseContractBindings,
    appendTaskEvent,
    createTempRepo,
    findLastTimelineEventIndex,
    getOrchestratorRoot,
    getReviewsRoot,
    initializeGitRepo,
    loadPostPreflightRulePack,
    loadTaskEntryRulePack,
    readTaskTimelineEvents,
    runEnterTaskMode,
    runExplicitPreflight,
    runHandshakeForTask,
    runShellSmokeForTask,
    resolveReviewerExecutionFixture,
    seedInitAnswers,
    seedReusableReviewEvidence,
    seedTaskQueue,
    writeCompilePassEvidence,
    writeHandshakeArtifact,
    writePreflight,
    writeReceiptBackedReviewArtifact,
    writeReviewCapabilitiesConfig,
    writeShellSmokeArtifact,
    appendPreflightClassifiedEvent,
    runGit
};

export function getReviewTreeStateSha256FromFixtureContext(reviewContext: Record<string, unknown>): string | null {
    const treeState = reviewContext.tree_state
        && typeof reviewContext.tree_state === 'object'
        && !Array.isArray(reviewContext.tree_state)
        ? reviewContext.tree_state as Record<string, unknown>
        : null;
    const normalized = String(treeState?.tree_state_sha256 || treeState?.treeStateSha256 || '').trim().toLowerCase();
    return /^[0-9a-f]{64}$/.test(normalized) ? normalized : null;
}

export function writeScopedDiffPathsConfig(repoRoot: string): string {
    const configPath = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'paths.json');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({
        triggers: {
            db: ['(^|/)(db|database|migrations?|schema)(/|$)', '\\.sql$'],
            security: ['(^|/)(auth|security|token|secret)(/|\\.|$)'],
            refactor: ['(^|/)refactor-never-match(/|$)'],
            api: ['(^|/)(controllers?|routes?)(/|\\.|$)'],
            dependency: ['(^|/)package\\.json$'],
            infra: ['(^|/)\\.github/workflows/'],
            test: ['(^|/)(__tests__|tests?)/', '\\.(spec|test)\\.(ts|tsx|js|jsx)$'],
            performance: ['(^|/)(performance|perf|benchmark)/']
        },
        runtime_roots: ['src/'],
        code_like_regexes: ['\\.(ts|tsx|js|jsx)$'],
        ordinary_doc_paths: ['CHANGELOG.md']
    }, null, 2) + '\n', 'utf8');
    return configPath;
}

export function buildScopedDiffFixture(
    repoRoot: string,
    taskId: string,
    reviewType: string,
    preflightPath: string,
    pathsConfigPath: string
): void {
    const reviewsRoot = getReviewsRoot(repoRoot);
    buildScopedDiff({
        reviewType,
        preflightPath,
        pathsConfigPath,
        outputPath: path.join(reviewsRoot, `${taskId}-${reviewType}-scoped.diff`),
        metadataPath: path.join(reviewsRoot, `${taskId}-${reviewType}-scoped.json`),
        repoRoot
    });
}

export function runGitBestEffort(repoRoot: string, args: string[]): void {
    childProcess.spawnSync('git', args, {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe']
    });
}

export function ensureReviewDiffFixture(repoRoot: string, preflightPath: string): void {
    const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
    const changedFiles = Array.isArray(preflight.changed_files)
        ? preflight.changed_files.map((entry) => String(entry || '').replace(/\\/g, '/').trim()).filter(Boolean)
        : [];
    if (changedFiles.length === 0) {
        return;
    }

    if (!fs.existsSync(path.join(repoRoot, '.git'))) {
        runGitBestEffort(repoRoot, ['init']);
    }
    runGitBestEffort(repoRoot, ['config', 'user.name', 'Garda Tests']);
    runGitBestEffort(repoRoot, ['config', 'user.email', 'garda-tests@example.com']);
    const head = childProcess.spawnSync('git', ['rev-parse', '--verify', 'HEAD'], {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe']
    });
    if (head.status !== 0) {
        runGitBestEffort(repoRoot, ['commit', '--allow-empty', '-m', 'baseline']);
    }

    for (const changedFile of changedFiles) {
        if (
            changedFile.startsWith('/')
            || changedFile.startsWith('../')
            || changedFile.includes('/../')
            || changedFile.startsWith(':')
        ) {
            continue;
        }
        const absolutePath = path.join(repoRoot, ...changedFile.split('/'));
        fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
        if (!fs.existsSync(absolutePath)) {
            fs.writeFileSync(absolutePath, `// review reuse fixture for ${changedFile}\n`, 'utf8');
        }
    }
}

function rehashTaskTimelineLines(lines: string[]): void {
    let previousEventSha256: string | null = null;
    for (let index = 0; index < lines.length; index += 1) {
        const event = JSON.parse(lines[index]) as Record<string, unknown>;
        const integrity = event.integrity && typeof event.integrity === 'object' && !Array.isArray(event.integrity)
            ? event.integrity as Record<string, unknown>
            : {};
        event.integrity = integrity;
        integrity.schema_version = 2;
        integrity.task_sequence = index + 1;
        integrity.prev_event_sha256 = previousEventSha256;
        delete integrity.event_sha256;
        const eventSha256 = buildEventIntegrityHash(event);
        assert.match(String(eventSha256 || ''), /^[a-f0-9]{64}$/u);
        integrity.event_sha256 = eventSha256;
        previousEventSha256 = eventSha256;
        lines[index] = JSON.stringify(event);
    }
}

export function insertTaskEventBeforeLatestWithCurrentIntegrity(
    repoRoot: string,
    taskId: string,
    eventType: string,
    outcome: string,
    message: string,
    details: Record<string, unknown>,
    predicate: (event: Record<string, unknown>) => boolean
): void {
    const timelinePath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'task-events', `${taskId}.jsonl`);
    fs.mkdirSync(path.dirname(timelinePath), { recursive: true });
    const lines = fs.readFileSync(timelinePath, 'utf8')
        .split('\n')
        .filter((line) => line.trim().length > 0);
    const insertBeforeIndex = findLastTimelineEventIndex(
        lines.map((line) => JSON.parse(line) as Record<string, unknown>),
        predicate
    );
    assert.notEqual(insertBeforeIndex, -1);
    lines.splice(insertBeforeIndex, 0, JSON.stringify({
        timestamp_utc: new Date().toISOString(),
        task_id: taskId,
        event_type: eventType,
        outcome,
        actor: 'test',
        message,
        details
    }));
    rehashTaskTimelineLines(lines);
    fs.writeFileSync(timelinePath, lines.join('\n') + '\n', 'utf8');
}

export function tamperLatestHistoricalReceiptSnapshot(repoRoot: string, taskId: string, reviewType: string): string {
    const historicalReviewRecorded = readTaskTimelineEvents(repoRoot, taskId)
        .reverse()
        .find((event) => {
            const details = event.details && typeof event.details === 'object' && !Array.isArray(event.details)
                ? event.details as Record<string, unknown>
                : null;
            return (
                event.event_type === 'REVIEW_RECORDED'
                && details
                && String(details.review_type || details.reviewType || '').trim().toLowerCase() === reviewType
                && details.reused_existing_review !== true
            );
        });
    assert.ok(historicalReviewRecorded);
    const details = historicalReviewRecorded.details as Record<string, unknown>;
    const snapshotPathRaw = String(details.receipt_snapshot_path || details.receiptSnapshotPath || '').trim();
    assert.ok(snapshotPathRaw);
    const snapshotPath = path.isAbsolute(snapshotPathRaw)
        ? snapshotPathRaw
        : path.resolve(repoRoot, snapshotPathRaw);
    fs.appendFileSync(snapshotPath, '\nTampered historical receipt snapshot after reuse telemetry was recorded.\n', 'utf8');
    return snapshotPath;
}

export function tamperLatestHistoricalArtifactSnapshot(repoRoot: string, taskId: string, reviewType: string): string {
    const historicalReviewRecorded = readTaskTimelineEvents(repoRoot, taskId)
        .reverse()
        .find((event) => {
            const details = event.details && typeof event.details === 'object' && !Array.isArray(event.details)
                ? event.details as Record<string, unknown>
                : null;
            return (
                event.event_type === 'REVIEW_RECORDED'
                && details
                && String(details.review_type || details.reviewType || '').trim().toLowerCase() === reviewType
                && details.reused_existing_review !== true
            );
        });
    assert.ok(historicalReviewRecorded);
    const details = historicalReviewRecorded.details as Record<string, unknown>;
    const snapshotPathRaw = String(details.review_artifact_snapshot_path || details.reviewArtifactSnapshotPath || '').trim();
    assert.ok(snapshotPathRaw);
    const snapshotPath = path.isAbsolute(snapshotPathRaw)
        ? snapshotPathRaw
        : path.resolve(repoRoot, snapshotPathRaw);
    fs.appendFileSync(snapshotPath, '\nTampered historical artifact snapshot after reuse telemetry was recorded.\n', 'utf8');
    return snapshotPath;
}

export function stripLatestHistoricalReceiptSnapshotTelemetry(repoRoot: string, taskId: string, reviewType: string): void {
    const timelinePath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'task-events', `${taskId}.jsonl`);
    const lines = fs.readFileSync(timelinePath, 'utf8')
        .split('\n')
        .filter(Boolean);
    let stripped = false;
    for (let index = lines.length - 1; index >= 0; index -= 1) {
        const event = JSON.parse(lines[index]) as Record<string, unknown>;
        const details = event.details && typeof event.details === 'object' && !Array.isArray(event.details)
            ? event.details as Record<string, unknown>
            : null;
        if (
            event.event_type === 'REVIEW_RECORDED'
            && details
            && String(details.review_type || details.reviewType || '').trim().toLowerCase() === reviewType
            && details.reused_existing_review !== true
        ) {
            delete details.receipt_snapshot_path;
            delete details.receiptSnapshotPath;
            delete details.receipt_snapshot_sha256;
            delete details.receiptSnapshotSha256;
            lines[index] = JSON.stringify(event);
            stripped = true;
            break;
        }
    }
    assert.equal(stripped, true);
    rehashTaskTimelineLines(lines);
    fs.writeFileSync(timelinePath, `${lines.join('\n')}\n`, 'utf8');
}

export function listReviewSnapshotArtifactNames(reviewsRoot: string, taskId: string, reviewType: string): string[] {
    return fs.readdirSync(reviewsRoot)
        .filter((name) => (
            name.startsWith(`${taskId}-${reviewType}-receipt-`)
            || name.startsWith(`${taskId}-${reviewType}-artifact-`)
        ))
        .sort();
}

export function updateLatestHistoricalReviewRecordedDetails(
    repoRoot: string,
    taskId: string,
    reviewType: string,
    update: (details: Record<string, unknown>) => void
): void {
    const timelinePath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'task-events', `${taskId}.jsonl`);
    const lines = fs.readFileSync(timelinePath, 'utf8')
        .split('\n')
        .filter(Boolean);
    let updated = false;
    for (let index = lines.length - 1; index >= 0; index -= 1) {
        const event = JSON.parse(lines[index]) as Record<string, unknown>;
        const details = event.details && typeof event.details === 'object' && !Array.isArray(event.details)
            ? event.details as Record<string, unknown>
            : null;
        if (
            event.event_type === 'REVIEW_RECORDED'
            && details
            && String(details.review_type || details.reviewType || '').trim().toLowerCase() === reviewType
            && details.reused_existing_review !== true
        ) {
            update(details);
            lines[index] = JSON.stringify(event);
            updated = true;
            break;
        }
    }
    assert.equal(updated, true);
    rehashTaskTimelineLines(lines);
    fs.writeFileSync(timelinePath, `${lines.join('\n')}\n`, 'utf8');
}
