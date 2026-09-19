import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Mode, OpenMode, PathLike } from 'node:fs';

import {
    fs,
    path,
    createHash,
    buildTaskAuditSummary,
    formatTaskAuditSummaryText,
    formatFinalCloseoutMarkdown,
    readReviewTrustSummary,
    PROJECT_MEMORY_IMPACT_ASSESSED_EVENT,
    computeFileSha256,
    writeEvent,
    writePreflight,
    writeArtifact,
    writeIntegrityEventSequence,
    writeWorkflowConfig,
    writeProjectMemoryWorkflowConfig,
    seedProjectMemory,
    writeProjectMemoryImpactArtifact,
    writeCurrentIndependentReviewFixture,
    initGitRepo,
    makeTempDir} from './task-audit-summary-fixtures';
import {
    ALL_REVIEW_FLAGS as REUSE_ALL_REVIEW_FLAGS,
    appendEvent as appendReuseEvent,
    fileSha256 as reuseFileSha256,
    makeTempRepo as makeReuseTempRepo,
    markReviewEvidenceAsStrictReuse as markReuseReviewEvidenceAsStrictReuse,
    reviewsRoot as reuseReviewsRoot,
    seedCompilePass as seedReuseCompilePass,
    seedStartedTask as seedReuseStartedTask,
    writePreflight as writeReusePreflight,
    writeReviewEvidence as writeReuseReviewEvidence
} from '../next-step/next-step-review-reuse-fixtures';
import { buildDomainScopeFingerprints } from '../../../../src/gates/scope/domain-scope-fingerprints';
import { formatFinalUserReport } from '../../../../src/gates/task-audit/task-audit-summary';

function isReadOnlyOpen(flags: OpenMode): boolean {
    if (typeof flags === 'string') {
        return flags === 'r' || flags === 'rs' || flags === 'sr';
    }
    return (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR)) === 0;
}

function captureTimelineReadOpens<T>(
    timelinePath: string,
    callback: () => T
): { result: T; readSites: string[] } {
    const fsModule = require('node:fs') as typeof import('node:fs');
    const originalOpenSync = fsModule.openSync;
    const readSites: string[] = [];
    fsModule.openSync = ((targetPath: PathLike, flags: OpenMode, mode?: Mode) => {
        if (
            path.resolve(String(targetPath)) === path.resolve(timelinePath)
            && isReadOnlyOpen(flags)
        ) {
            readSites.push(new Error().stack || 'stack unavailable');
        }
        return originalOpenSync(targetPath, flags, mode);
    }) as typeof fsModule.openSync;
    try {
        return { result: callback(), readSites };
    } finally {
        fsModule.openSync = originalOpenSync;
    }
}

function appendCurrentStrictReuseRecordedForAudit(repoRoot: string, taskId: string, reviewType: string): void {
    const root = reuseReviewsRoot(repoRoot);
    const receiptPath = path.join(root, `${taskId}-${reviewType}-receipt.json`);
    const artifactPath = path.join(root, `${taskId}-${reviewType}.md`);
    const contextPath = path.join(root, `${taskId}-${reviewType}-review-context.json`);
    const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8')) as Record<string, unknown>;
    const receiptSha256 = reuseFileSha256(receiptPath);
    const receiptSnapshotPath = path.join(root, `${taskId}-${reviewType}-receipt-${receiptSha256}.json`);
    const reviewArtifactSha256 = reuseFileSha256(artifactPath);
    const reviewArtifactSnapshotPath = path.join(root, `${taskId}-${reviewType}-artifact-${reviewArtifactSha256}.md`);
    fs.copyFileSync(receiptPath, receiptSnapshotPath);
    fs.copyFileSync(artifactPath, reviewArtifactSnapshotPath);
    appendReuseEvent(repoRoot, taskId, 'REVIEW_RECORDED', 'PASS', {
        ...receipt,
        receipt_path: receiptPath,
        receipt_sha256: receiptSha256,
        receipt_snapshot_path: receiptSnapshotPath,
        receipt_snapshot_sha256: receiptSha256,
        review_artifact_path: artifactPath,
        review_artifact_sha256: reviewArtifactSha256,
        review_artifact_snapshot_path: reviewArtifactSnapshotPath,
        review_artifact_snapshot_sha256: reviewArtifactSha256,
        review_context_path: contextPath,
        review_context_sha256: reuseFileSha256(contextPath),
        review_context_reuse_sha256: receipt.review_context_reuse_sha256,
        review_tree_state_sha256: receipt.review_tree_state_sha256,
        reused_existing_review: true
    });
}

function clearCurrentReuseTimingForAudit(repoRoot: string, taskId: string, reviewType: string): void {
    const receiptPath = path.join(reuseReviewsRoot(repoRoot), `${taskId}-${reviewType}-receipt.json`);
    const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8')) as Record<string, unknown>;
    const provenance = receipt.reviewer_provenance as Record<string, unknown>;
    for (const field of [
        'launch_prepared_at_utc',
        'delegation_started_at_utc',
        'launched_at_utc',
        'launch_completed_at_utc',
        'invocation_attested_at_utc'
    ]) {
        delete provenance[field];
    }
    delete receipt.review_result_recorded_at_utc;
    delete receipt.review_output_source_mtime_utc;
    fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
}


describe('gates/task-audit-summary', () => {
    let tmpDir: string;
    let eventsDir: string;
    let reviewsDir: string;
    const TASK_ID = 'T-AUDIT-1';

    beforeEach(() => {
        tmpDir = makeTempDir();
        eventsDir = path.join(tmpDir, 'garda-agent-orchestrator', 'runtime', 'task-events');
        reviewsDir = path.join(tmpDir, 'garda-agent-orchestrator', 'runtime', 'reviews');
        fs.mkdirSync(eventsDir, { recursive: true });
        fs.mkdirSync(reviewsDir, { recursive: true });
        writeWorkflowConfig(tmpDir, false);
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    describe('buildTaskAuditSummary', () => {
        it('returns INCOMPLETE for task with no events', () => {
            // Create an empty events file
            fs.writeFileSync(path.join(eventsDir, `${TASK_ID}.jsonl`), '', 'utf8');

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            assert.equal(result.task_id, TASK_ID);
            assert.equal(result.status, 'INCOMPLETE');
            assert.equal(result.events_count, 0);
            assert.ok(result.gates.length > 0);
            assert.ok(result.gates.every(g => g.status === 'MISSING'));
            assert.equal(result.final_closeout.review_coverage_summary?.status, 'NOT_REQUIRED');
            assert.ok(formatFinalCloseoutMarkdown(result.final_closeout).includes('Review coverage: status=NOT_REQUIRED'));
        });

        it('detects passed gates from events', () => {
            const now = new Date().toISOString();
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: now,
                task_id: TASK_ID,
                event_type: 'TASK_MODE_ENTERED',
                outcome: 'PASS',
                actor: 'gate',
                message: 'Task mode entered.'
            });
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: now,
                task_id: TASK_ID,
                event_type: 'RULE_PACK_LOADED',
                outcome: 'PASS',
                actor: 'gate',
                message: 'Rule pack loaded.'
            });

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            const taskModeGate = result.gates.find(g => g.gate === 'enter-task-mode');
            assert.ok(taskModeGate);
            assert.equal(taskModeGate.status, 'PASS');

            const rulePackGate = result.gates.find(g => g.gate === 'load-rule-pack');
            assert.ok(rulePackGate);
            assert.equal(rulePackGate.status, 'PASS');
        });

        it('shares one authenticated capture with the optional-skill timeline reader', () => {
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: '2026-01-01T00:00:00.000Z',
                task_id: TASK_ID,
                event_type: 'TASK_MODE_ENTERED',
                outcome: 'PASS',
                actor: 'gate',
                message: 'Task mode entered.'
            });
            const timelinePath = path.join(eventsDir, `${TASK_ID}.jsonl`);
            const expectedSha256 = computeFileSha256(timelinePath);

            const { result, readSites } = captureTimelineReadOpens(timelinePath, () => (
                buildTaskAuditSummary({
                    taskId: TASK_ID,
                    repoRoot: tmpDir,
                    eventsRoot: eventsDir,
                    reviewsRoot: reviewsDir
                })
            ));

            const taskEventsEvidence = result.evidence.find((entry) => entry.kind === 'task-events');
            assert.equal(taskEventsEvidence?.exists, true);
            assert.equal(taskEventsEvidence?.sha256, expectedSha256);
            assert.equal(readSites.length, 1, readSites.join('\n\n'));
            assert.equal(
                readSites.filter((site) => site.includes('captureTaskTimelineRead')).length,
                1,
                readSites.join('\n\n')
            );
        });

        it('rejects an events root redirected outside the repository', (t) => {
            const foreignEventsRoot = makeTempDir();
            fs.rmSync(eventsDir, { recursive: true, force: true });
            try {
                try {
                    fs.symlinkSync(
                        foreignEventsRoot,
                        eventsDir,
                        process.platform === 'win32' ? 'junction' : 'dir'
                    );
                } catch (error) {
                    t.skip(
                        `directory symlink creation unavailable in this environment: ${
                            error instanceof Error ? error.message : String(error)
                        }`
                    );
                    return;
                }

                assert.throws(
                    () => buildTaskAuditSummary({
                        taskId: TASK_ID,
                        repoRoot: tmpDir,
                        eventsRoot: eventsDir,
                        reviewsRoot: reviewsDir
                    }),
                    /Path must resolve inside repo root without symlink or junction escapes/u
                );
            } finally {
                fs.rmSync(foreignEventsRoot, { recursive: true, force: true });
            }
        });

        it('surfaces partial task-cycle diagnostics from status timeline warnings', () => {
            fs.writeFileSync(
                path.join(tmpDir, 'TASK.md'),
                [
                    '# TASK.md',
                    '',
                    '## Active Queue',
                    '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
                    '|---|---|---|---|---|---|---|---|---|',
                    `| ${TASK_ID} | 🟨 IN_PROGRESS | P1 | runtime | Partial task | codex | 2026-06-29 | balanced | partial lifecycle |`,
                    ''
                ].join('\n'),
                'utf8'
            );
            writeIntegrityEventSequence(eventsDir, TASK_ID, [
                { event_type: 'TASK_MODE_ENTERED' }
            ]);

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            assert.equal(result.status, 'INCOMPLETE');
            assert.equal(result.task_cycle_diagnostics?.status, 'PARTIAL');
            assert.equal(result.task_cycle_diagnostics?.timeline_warning_kind, 'INCOMPLETE');
            assert.equal(result.task_cycle_diagnostics?.task_status, 'IN_PROGRESS');
            assert.ok(result.task_cycle_diagnostics?.missing_lifecycle_events.includes('RULE_PACK_LOADED'));
            assert.ok(result.task_cycle_diagnostics?.message?.includes('workspace readiness is evaluated separately'));
            assert.equal(result.blockers.some((blocker) => blocker.gate === 'task-cycle-diagnostics'), false);
            assert.equal(result.final_closeout.task_cycle_diagnostics?.status, 'PARTIAL');

            const rendered = formatTaskAuditSummaryText(result);
            assert.ok(rendered.includes('TaskCycleDiagnostics: Task-cycle diagnostic: status=PARTIAL'));
            const finalMarkdown = formatFinalCloseoutMarkdown(result.final_closeout);
            assert.ok(finalMarkdown.includes('Task-cycle diagnostic: status=PARTIAL'));
        });

        it('prevents recursive global toxin traversal on cold and warm task-audit reads', () => {
            fs.writeFileSync(
                path.join(tmpDir, 'TASK.md'),
                [
                    '# TASK.md',
                    '',
                    '## Active Queue',
                    '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
                    '|---|---|---|---|---|---|---|---|---|',
                    `| ${TASK_ID} | 🟨 IN_PROGRESS | P1 | runtime | Narrow audit | codex | 2026-08-02 | balanced | partial lifecycle |`,
                    ''
                ].join('\n'),
                'utf8'
            );
            writeIntegrityEventSequence(eventsDir, TASK_ID, [
                { event_type: 'TASK_MODE_ENTERED' }
            ]);
            const toxinRoot = path.join(tmpDir, 'garda-agent-orchestrator', 'runtime', 'backups');
            for (let index = 0; index < 20; index++) {
                const artifactPath = path.join(toxinRoot, `batch-${index}`, 'artifact.json');
                fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
                fs.writeFileSync(artifactPath, '{}\n', 'utf8');
            }
            const fsModule = require('node:fs') as typeof import('node:fs');
            const originalReaddirSync = fsModule.readdirSync;
            const traversalCounts = [0, 0];
            let phase = 0;
            fsModule.readdirSync = ((targetPath: fs.PathLike, options?: unknown) => {
                const resolvedPath = path.resolve(String(targetPath));
                if (resolvedPath === path.resolve(toxinRoot) || resolvedPath.startsWith(`${path.resolve(toxinRoot)}${path.sep}`)) {
                    traversalCounts[phase]++;
                }
                return originalReaddirSync(targetPath, options as never);
            }) as typeof fsModule.readdirSync;
            try {
                const cold = buildTaskAuditSummary({
                    taskId: TASK_ID,
                    repoRoot: tmpDir,
                    eventsRoot: eventsDir,
                    reviewsRoot: reviewsDir
                });
                phase = 1;
                const warm = buildTaskAuditSummary({
                    taskId: TASK_ID,
                    repoRoot: tmpDir,
                    eventsRoot: eventsDir,
                    reviewsRoot: reviewsDir
                });

                assert.equal(cold.task_cycle_diagnostics?.timeline_warning_kind, 'INCOMPLETE');
                assert.equal(warm.task_cycle_diagnostics?.timeline_warning_kind, 'INCOMPLETE');
                assert.deepEqual(traversalCounts, [0, 0]);
            } finally {
                fsModule.readdirSync = originalReaddirSync;
            }
        });

        it('surfaces corrupt task-cycle diagnostics without treating them as missing lifecycle events', () => {
            fs.writeFileSync(
                path.join(tmpDir, 'TASK.md'),
                [
                    '# TASK.md',
                    '',
                    '## Active Queue',
                    '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
                    '|---|---|---|---|---|---|---|---|---|',
                    `| ${TASK_ID} | 🟨 IN_PROGRESS | P1 | runtime | Corrupt task | codex | 2026-06-29 | balanced | diagnostic lifecycle |`,
                    ''
                ].join('\n'),
                'utf8'
            );
            fs.writeFileSync(
                path.join(eventsDir, `${TASK_ID}.jsonl`),
                JSON.stringify({
                    timestamp_utc: '2026-06-29T10:00:00.000Z',
                    task_id: TASK_ID,
                    event_type: 'TASK_MODE_ENTERED',
                    outcome: 'PASS',
                    actor: 'gate',
                    message: 'Task mode entered.',
                    details: {},
                    integrity: {
                        schema_version: 1,
                        task_sequence: 1,
                        prev_event_sha256: null,
                        event_sha256: '0'.repeat(64)
                    }
                }) + '\n',
                'utf8'
            );

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            assert.equal(result.task_cycle_diagnostics?.status, 'DIAGNOSTIC');
            assert.equal(result.task_cycle_diagnostics?.timeline_warning_kind, 'INTEGRITY_FAILED');
            assert.equal(result.task_cycle_diagnostics?.task_status, 'IN_PROGRESS');
            assert.deepEqual(result.task_cycle_diagnostics?.missing_lifecycle_events, []);
            assert.ok(result.task_cycle_diagnostics?.message?.includes('workspace readiness is evaluated separately'));
            assert.ok(result.task_cycle_diagnostics?.repair_guidance?.includes('tampered/corrupt evidence'));
            assert.equal(result.blockers.some((blocker) => blocker.gate === 'task-cycle-diagnostics'), false);
            assert.equal(result.final_closeout.task_cycle_diagnostics?.status, 'DIAGNOSTIC');

            const rendered = formatTaskAuditSummaryText(result);
            assert.ok(rendered.includes('TaskCycleDiagnostics: Task-cycle diagnostic: status=DIAGNOSTIC'));
            const finalMarkdown = formatFinalCloseoutMarkdown(result.final_closeout);
            assert.ok(finalMarkdown.includes('Task-cycle diagnostic: status=DIAGNOSTIC'));
        });

        it('includes project-memory-impact gate and final closeout project memory status', () => {
            writeProjectMemoryWorkflowConfig(tmpDir);
            seedProjectMemory(tmpDir);
            writePreflight(reviewsDir, TASK_ID, {
                changed_files: ['src/app.ts'],
                metrics: { changed_lines_total: 3 },
                required_reviews: {
                    code: false,
                    db: false,
                    security: false,
                    refactor: false,
                    api: false,
                    test: false,
                    performance: false,
                    infra: false,
                    dependency: false
                }
            });
            writeArtifact(reviewsDir, TASK_ID, '-doc-impact.json', {
                task_id: TASK_ID,
                status: 'PASSED',
                outcome: 'PASS',
                decision: 'NO_DOC_UPDATES'
            });
            fs.writeFileSync(
                path.join(tmpDir, 'garda-agent-orchestrator', 'live', 'docs', 'project-memory', 'compact.md'),
                'x'.repeat(13000),
                'utf8'
            );
            writeProjectMemoryImpactArtifact(tmpDir, TASK_ID);
            writeIntegrityEventSequence(eventsDir, TASK_ID, [
                { event_type: 'TASK_MODE_ENTERED' },
                { event_type: 'RULE_PACK_LOADED' },
                { event_type: 'HANDSHAKE_DIAGNOSTICS_RECORDED' },
                { event_type: 'SHELL_SMOKE_PREFLIGHT_RECORDED' },
                { event_type: 'PREFLIGHT_CLASSIFIED' },
                { event_type: 'IMPLEMENTATION_STARTED' },
                { event_type: 'COMPILE_GATE_PASSED' },
                { event_type: 'REVIEW_PHASE_STARTED' },
                { event_type: 'REVIEW_GATE_PASSED' },
                { event_type: 'DOC_IMPACT_ASSESSED' },
                { event_type: PROJECT_MEMORY_IMPACT_ASSESSED_EVENT },
                { event_type: 'COMPLETION_GATE_PASSED' }
            ]);

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            assert.equal(result.gates.find(g => g.gate === 'project-memory-impact')?.status, 'PASS');
            assert.equal(result.final_closeout.project_memory?.evidence_status, 'CURRENT');
            assert.equal(result.final_closeout.project_memory?.status, 'NO_UPDATE_NEEDED');
            assert.equal(result.final_closeout.project_memory?.compact_status, 'OVERFLOW_NON_BLOCKING_NO_UPDATE');
            assert.ok(result.final_closeout.known_non_blocking_signals?.some((signal) => (
                signal.id === 'project_memory_no_update_compact_overflow_accepted'
                && signal.action_required === false
            )));
            const rendered = formatTaskAuditSummaryText(result);
            assert.ok(rendered.includes('Project memory: enabled; mode=check'));
            assert.ok(rendered.includes('compact=OVERFLOW_NON_BLOCKING_NO_UPDATE'));
            assert.ok(rendered.includes('compact_refreshed=not_required'));
            assert.ok(rendered.includes('Known non-blocking notes: Project memory compact overflow is non-blocking because this task does not require a memory update.'));
            assert.equal(rendered.includes('KnownNonBlockingSignals:'), false);
            assert.equal(rendered.includes('compact=OVERFLOW; compact_refreshed=false'), false);
            const finalMarkdown = formatFinalCloseoutMarkdown(result.final_closeout);
            assert.ok(finalMarkdown.includes('Project memory: enabled; mode=check'));
            assert.ok(finalMarkdown.includes('compact=OVERFLOW_NON_BLOCKING_NO_UPDATE'));
            assert.ok(finalMarkdown.includes('compact_refreshed=not_required'));
            assert.ok(finalMarkdown.includes('Known non-blocking notes: Project memory compact overflow is non-blocking because this task does not require a memory update.'));
            assert.equal(finalMarkdown.includes('KnownNonBlockingSignals:'), false);
            const finalUserReport = formatFinalUserReport(result.final_closeout);
            assert.ok(finalUserReport.includes('Process warnings:'));
            assert.ok(finalUserReport.includes('Project memory compact overflow is non-blocking because this task does not require a memory update.'));
            assert.equal(finalUserReport.includes('project_memory_no_update_compact_overflow_accepted'), false);
        });

        it('does not block final closeout on historical project-memory events after maintenance is disabled', () => {
            writeProjectMemoryWorkflowConfig(tmpDir);
            seedProjectMemory(tmpDir);
            writePreflight(reviewsDir, TASK_ID, {
                changed_files: ['src/app.ts'],
                metrics: { changed_lines_total: 3 },
                required_reviews: {
                    code: false,
                    db: false,
                    security: false,
                    refactor: false,
                    api: false,
                    test: false,
                    performance: false,
                    infra: false,
                    dependency: false
                }
            });
            writeArtifact(reviewsDir, TASK_ID, '-doc-impact.json', {
                task_id: TASK_ID,
                status: 'PASSED',
                outcome: 'PASS',
                decision: 'NO_DOC_UPDATES'
            });
            writeProjectMemoryImpactArtifact(tmpDir, TASK_ID);
            writeIntegrityEventSequence(eventsDir, TASK_ID, [
                { event_type: 'TASK_MODE_ENTERED' },
                { event_type: 'RULE_PACK_LOADED' },
                { event_type: 'HANDSHAKE_DIAGNOSTICS_RECORDED' },
                { event_type: 'SHELL_SMOKE_PREFLIGHT_RECORDED' },
                { event_type: 'PREFLIGHT_CLASSIFIED' },
                { event_type: 'IMPLEMENTATION_STARTED' },
                { event_type: 'COMPILE_GATE_PASSED' },
                { event_type: 'REVIEW_PHASE_STARTED' },
                { event_type: 'REVIEW_GATE_PASSED' },
                { event_type: 'DOC_IMPACT_ASSESSED' },
                { event_type: PROJECT_MEMORY_IMPACT_ASSESSED_EVENT },
                { event_type: 'COMPLETION_GATE_PASSED' }
            ]);
            writeProjectMemoryWorkflowConfig(tmpDir, false);

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            assert.equal(result.status, 'PASS');
            assert.equal(result.gates.some(g => g.gate === 'project-memory-impact'), false);
            assert.equal(result.final_closeout.project_memory?.evidence_status, 'NOT_REQUIRED');
            assert.equal(result.blockers.some((blocker) => blocker.gate === 'project-memory-impact'), false);
        });

        it('reads changed files from preflight', () => {
            fs.writeFileSync(path.join(eventsDir, `${TASK_ID}.jsonl`), '', 'utf8');
            writePreflight(reviewsDir, TASK_ID, {
                changed_files: ['src/foo.ts', 'src/bar.ts'],
                metrics: { changed_lines_total: 42 },
                required_reviews: { code: true, db: false, security: false, refactor: false }
            });

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            assert.deepEqual(result.changed_files, ['src/foo.ts', 'src/bar.ts']);
            assert.equal(result.changed_files_count, 2);
            assert.equal(result.changed_lines_total, 42);
            assert.equal(result.final_closeout.implementation_summary.change_metrics?.preflight_changed_files_count, 2);
            assert.equal(result.final_closeout.implementation_summary.change_metrics?.preflight_changed_lines_total, 42);
            assert.equal(result.final_closeout.implementation_summary.change_metrics?.final_tracked_changed_files_count, 2);
            assert.equal(result.final_closeout.implementation_summary.changed_lines_total, 42);
            assert.equal(result.required_reviews.code, true);
            assert.equal(result.required_reviews.db, false);
        });

        it('labels preflight and final changed-line metrics when closeout adds late evidence files', () => {
            initGitRepo(tmpDir);
            fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
            fs.writeFileSync(path.join(tmpDir, 'src', 'app.ts'), 'const value = 1;\n', 'utf8');
            fs.writeFileSync(path.join(tmpDir, 'CHANGELOG.md'), '# Changelog\n\n- Updated closeout evidence.\n', 'utf8');
            writePreflight(reviewsDir, TASK_ID, {
                changed_files: ['src/app.ts'],
                metrics: { changed_lines_total: 1 },
                required_reviews: {
                    code: false,
                    db: false,
                    security: false,
                    refactor: false,
                    api: false,
                    test: false,
                    performance: false,
                    infra: false,
                    dependency: false
                }
            });
            writeArtifact(reviewsDir, TASK_ID, '-doc-impact.json', {
                task_id: TASK_ID,
                status: 'PASSED',
                outcome: 'PASS',
                decision: 'DOCS_UPDATED',
                docs_updated: ['CHANGELOG.md']
            });

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            assert.deepEqual(result.changed_files, ['src/app.ts', 'CHANGELOG.md']);
            assert.equal(result.final_closeout.implementation_summary.change_metrics?.preflight_changed_files_count, 1);
            assert.equal(result.final_closeout.implementation_summary.change_metrics?.preflight_changed_lines_total, 1);
            assert.equal(result.final_closeout.implementation_summary.change_metrics?.final_tracked_changed_files_count, 2);
            assert.equal(result.final_closeout.implementation_summary.change_metrics?.final_tracked_changed_lines_total, 3);
            assert.deepEqual(result.final_closeout.implementation_summary.change_metrics?.late_evidence_files, ['CHANGELOG.md']);
            assert.equal(result.changed_lines_total, 3);
            assert.equal(result.final_closeout.implementation_summary.changed_lines_total, 3);

            const rendered = formatTaskAuditSummaryText(result);
            assert.ok(rendered.includes('ChangedFiles: 2'));
            assert.ok(!rendered.includes('ChangedFiles: 2 (1 lines)'));
            assert.ok(rendered.includes('PreflightChangedLines: 1'));
            assert.ok(rendered.includes('FinalTrackedChangedLines: 3'));
            assert.ok(rendered.includes('LateEvidenceFiles: CHANGELOG.md'));

            const markdown = formatFinalCloseoutMarkdown(result.final_closeout);
            assert.ok(markdown.includes('Current audited changed files: 2.'));
            assert.ok(!markdown.includes('Current audited changed files: 2 (1 lines).'));
            assert.ok(markdown.includes('Preflight changed lines: 1.'));
            assert.ok(markdown.includes('Final tracked changed lines: 3.'));
            assert.ok(markdown.includes('Late evidence files: CHANGELOG.md.'));
        });

        it('normalizes profile review decisions to the enforced required reviews', () => {
            writeArtifact(reviewsDir, TASK_ID, '-task-mode.json', {
                task_id: TASK_ID,
                active_profile: 'strict'
            });
            writePreflight(reviewsDir, TASK_ID, {
                changed_files: ['src/gates/task-audit-summary.ts'],
                metrics: { changed_lines_total: 12 },
                scope_category: 'audit-only',
                required_reviews: {
                    code: true,
                    dependency: true,
                    test: true
                },
                profile_guardrails: {
                    guardrails_active: false,
                    lightening_eligible: true,
                    decisions: [
                        {
                            review_type: 'code',
                            effective_value: false,
                            decision: 'lightened_by_profile'
                        },
                        {
                            review_type: 'security',
                            effective_value: true,
                            decision: 'capability_default'
                        },
                        {
                            review_type: 'refactor',
                            effective_value: true,
                            decision: 'capability_default'
                        }
                    ],
                    safety_floors_applied: []
                }
            });

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });
            const decisions = result.profile_review_decisions?.decisions || [];
            const byType = new Map(decisions.map((decision) => [decision.review_type, decision]));
            const rendered = formatTaskAuditSummaryText(result);

            assert.equal(byType.get('code')?.effective_value, true);
            assert.equal(byType.get('code')?.decision, 'preflight_required');
            assert.equal(byType.get('security')?.effective_value, false);
            assert.equal(byType.get('security')?.decision, 'not_required_by_preflight');
            assert.equal(byType.get('refactor')?.effective_value, false);
            assert.equal(byType.get('refactor')?.decision, 'not_required_by_preflight');
            assert.equal(byType.get('dependency')?.effective_value, true);
            assert.equal(byType.get('dependency')?.decision, 'preflight_required');
            assert.equal(byType.get('test')?.effective_value, true);
            assert.equal(byType.get('test')?.decision, 'preflight_required');
            assert.ok(rendered.includes('RequiredReviews: code, dependency, test'));
            assert.ok(rendered.includes('  [+] code: true (preflight_required)'));
            assert.ok(rendered.includes('  [-] security: false (not_required_by_preflight)'));
            assert.ok(rendered.includes('  [-] refactor: false (not_required_by_preflight)'));
            assert.ok(rendered.includes('  [+] dependency: true (preflight_required)'));
            assert.ok(rendered.includes('  [+] test: true (preflight_required)'));
            assert.ok(rendered.includes('security review not required because preflight required_reviews.security=false'));
            assert.ok(rendered.includes('refactor review not required because preflight required_reviews.refactor=false'));
            assert.ok(rendered.includes('dependency review kept because preflight required_reviews.dependency=true'));
            assert.ok(!rendered.includes('security: true (capability_default)'));
            assert.ok(!rendered.includes('refactor: true (capability_default)'));
        });

        it('accepts stale review receipts only when persisted domain fingerprints match current scope', () => {
            const changedFiles = ['src/gates/task-audit-summary.ts'];
            const currentPreflight = {
                detection_source: 'git_auto',
                include_untracked: true,
                changed_files: changedFiles,
                required_reviews: { code: true }
            };
            writePreflight(reviewsDir, TASK_ID, currentPreflight);
            const currentPreflightSha256 = computeFileSha256(path.join(reviewsDir, `${TASK_ID}-preflight.json`));
            const stalePreflightSha256 = 'a'.repeat(64);
            const matchingDomainScopeFingerprints = buildDomainScopeFingerprints({
                repoRoot: tmpDir,
                detectionSource: 'git_auto',
                includeUntracked: true,
                changedFiles
            });
            writeCurrentIndependentReviewFixture({
                reviewsDir,
                taskId: TASK_ID,
                preflightSha256: stalePreflightSha256,
                receiptOverrides: {
                    domain_scope_fingerprints: matchingDomainScopeFingerprints
                }
            });

            const matchingSummary = readReviewTrustSummary(
                { code: true },
                reviewsDir,
                TASK_ID,
                'code',
                currentPreflightSha256,
                currentPreflight,
                tmpDir
            );

            assert.equal(matchingSummary?.status, 'INDEPENDENT_AUDITED');

            const mismatchedDomainScopeFingerprints = buildDomainScopeFingerprints({
                repoRoot: tmpDir,
                detectionSource: 'git_auto',
                includeUntracked: true,
                changedFiles: ['src/gates/next-step.ts']
            });
            writeCurrentIndependentReviewFixture({
                reviewsDir,
                taskId: TASK_ID,
                preflightSha256: stalePreflightSha256,
                receiptOverrides: {
                    domain_scope_fingerprints: mismatchedDomainScopeFingerprints
                }
            });

            const mismatchedSummary = readReviewTrustSummary(
                { code: true },
                reviewsDir,
                TASK_ID,
                'code',
                currentPreflightSha256,
                currentPreflight,
                tmpDir
            );

            assert.equal(mismatchedSummary?.status, 'UNAVAILABLE');
        });

        it('surfaces task-mode workflow-config authorization in audit and closeout output', () => {
            const plannedChangedFiles = ['garda-agent-orchestrator/live/config/workflow-config.json'];
            const dirtyBaselineChangedFiles = ['src/gates/next-step/next-step.ts'];
            initGitRepo(tmpDir);
            const workflowConfigPath = path.join(tmpDir, ...plannedChangedFiles[0].split('/'));
            const beforeWorkflowConfigText = fs.readFileSync(workflowConfigPath, 'utf8');
            const beforeWorkflowConfigSha256 = computeFileSha256(workflowConfigPath);
            writePreflight(reviewsDir, TASK_ID, {
                changed_files: plannedChangedFiles,
                metrics: { changed_lines_total: 3 },
                required_reviews: {
                    code: false,
                    db: false,
                    security: false,
                    refactor: false,
                    api: false,
                    test: false,
                    performance: false,
                    infra: false,
                    dependency: false
                }
            });
            writeArtifact(reviewsDir, TASK_ID, '-task-mode.json', {
                task_id: TASK_ID,
                orchestrator_work: true,
                workflow_config_work: true,
                planned_changed_files: plannedChangedFiles,
                workflow_config_file_hashes: {
                    [plannedChangedFiles[0]]: beforeWorkflowConfigSha256
                },
                dirty_workspace_baseline: {
                    detection_source: 'git_auto',
                    include_untracked: true,
                    changed_files: dirtyBaselineChangedFiles,
                    changed_files_sha256: 'dirty-baseline-files-sha',
                    scope_sha256: 'dirty-baseline-scope-sha',
                    file_hashes: {}
                },
                requested_depth: 2,
                effective_depth: 2,
                active_profile: 'standard'
            });
            writeArtifact(reviewsDir, TASK_ID, '-doc-impact.json', {
                task_id: TASK_ID,
                status: 'PASSED',
                outcome: 'PASS',
                decision: 'NO_DOC_UPDATES'
            });
            const workflowConfig = JSON.parse(beforeWorkflowConfigText) as Record<string, unknown>;
            const fullSuiteValidation = workflowConfig.full_suite_validation as Record<string, unknown>;
            fullSuiteValidation.out_of_scope_failure_policy = 'audit_and_warn';
            fs.writeFileSync(workflowConfigPath, `${JSON.stringify(workflowConfig, null, 2)}\n`, 'utf8');
            const afterWorkflowConfigSha256 = computeFileSha256(workflowConfigPath);
            const workflowConfigAuditPath = path.join(
                tmpDir,
                'garda-agent-orchestrator',
                'runtime',
                'workflow-config-audit.jsonl'
            );
            fs.writeFileSync(workflowConfigAuditPath, `${JSON.stringify({
                schema_version: 1,
                event_source: 'workflow-config-set',
                timestamp_utc: '2026-04-29T00:00:05.000Z',
                actor: 'local_ui',
                command: 'workflow set',
                mutation_source: 'local-ui',
                config_path: workflowConfigPath.replace(/\\/g, '/'),
                changed_fields: ['full_suite_validation.out_of_scope_failure_policy'],
                active_task_ids: [TASK_ID],
                active_task_id: TASK_ID,
                ui_session: {
                    action_session: 'enabled',
                    running_marker: true
                },
                before_sha256: beforeWorkflowConfigSha256,
                after_sha256: afterWorkflowConfigSha256
            })}\n`, 'utf8');
            writeIntegrityEventSequence(eventsDir, TASK_ID, [
                { event_type: 'TASK_MODE_ENTERED' },
                { event_type: 'RULE_PACK_LOADED' },
                { event_type: 'HANDSHAKE_DIAGNOSTICS_RECORDED' },
                { event_type: 'SHELL_SMOKE_PREFLIGHT_RECORDED' },
                { event_type: 'PREFLIGHT_CLASSIFIED' },
                { event_type: 'IMPLEMENTATION_STARTED' },
                { event_type: 'COMPILE_GATE_PASSED' },
                { event_type: 'REVIEW_PHASE_STARTED' },
                { event_type: 'REVIEW_GATE_PASSED' },
                { event_type: 'DOC_IMPACT_ASSESSED' },
                { event_type: 'COMPLETION_GATE_PASSED' }
            ]);

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            assert.equal(result.final_closeout.implementation_summary.orchestrator_work, true);
            assert.equal(result.final_closeout.implementation_summary.workflow_config_work, true);
            assert.deepEqual(result.final_closeout.implementation_summary.planned_changed_files, plannedChangedFiles);
            assert.deepEqual(result.final_closeout.implementation_summary.task_mode_scope_snapshot, {
                orchestrator_work: true,
                workflow_config_work: true,
                planned_changed_files: plannedChangedFiles,
                dirty_workspace_baseline_changed_files: dirtyBaselineChangedFiles,
                authorized_changed_files: [
                    ...plannedChangedFiles,
                    ...dirtyBaselineChangedFiles
                ].sort()
            });
            assert.deepEqual(
                result.final_closeout.implementation_summary.domain_scope_fingerprints?.domains.config.changed_files,
                plannedChangedFiles
            );

            const expectedLine =
                'orchestrator_work=true; workflow_config_work=true; ' +
                'planned_changed_files=garda-agent-orchestrator/live/config/workflow-config.json';
            assert.ok(formatTaskAuditSummaryText(result).includes(`TaskModeAuthorization: ${expectedLine}`));
            assert.ok(formatTaskAuditSummaryText(result).includes(
                'TaskModeAuthorizationSnapshot: orchestrator_work=true; workflow_config_work=true; ' +
                'original_planned_changed_files=garda-agent-orchestrator/live/config/workflow-config.json; ' +
                'dirty_workspace_baseline_changed_files=src/gates/next-step/next-step.ts; ' +
                'authorized_changed_files=garda-agent-orchestrator/live/config/workflow-config.json, src/gates/next-step/next-step.ts ' +
                '(historical task-mode authorization snapshot; current audited files are reported in ChangedFiles)'
            ));
            assert.ok(formatTaskAuditSummaryText(result).includes('CurrentAuditedChangedFiles: 1'));
            assert.ok(formatTaskAuditSummaryText(result).includes('PreflightChangedLines: 3'));
            assert.ok(formatFinalCloseoutMarkdown(result.final_closeout).includes(`Task-mode authorization: ${expectedLine}.`));
            assert.ok(formatFinalCloseoutMarkdown(result.final_closeout).includes(
                'Task-mode authorization snapshot: orchestrator_work=true; workflow_config_work=true; ' +
                'original_planned_changed_files=garda-agent-orchestrator/live/config/workflow-config.json; ' +
                'dirty_workspace_baseline_changed_files=src/gates/next-step/next-step.ts; ' +
                'authorized_changed_files=garda-agent-orchestrator/live/config/workflow-config.json, src/gates/next-step/next-step.ts ' +
                '(historical task-mode authorization snapshot; current audited files are reported in ChangedFiles).'
            ));
            assert.ok(formatFinalCloseoutMarkdown(result.final_closeout).includes('Current audited changed files: 1.'));
            assert.ok(formatFinalCloseoutMarkdown(result.final_closeout).includes('Preflight changed lines: 3.'));
            assert.equal(result.final_closeout.workflow?.workflow_config_audit?.status, 'audited');
            assert.deepEqual(
                result.final_closeout.workflow?.workflow_config_audit?.audited_files,
                plannedChangedFiles
            );
            assert.ok(formatTaskAuditSummaryText(result).includes(
                'Workflow-config audit warning: guarded workflow-config changed during this task; source=local-ui'
            ));
            assert.ok(formatFinalCloseoutMarkdown(result.final_closeout).includes(
                'Workflow-config audit warning: guarded workflow-config changed during this task; source=local-ui'
            ));
        });

        it('surfaces reviewer timing provenance only in operator audit output', () => {
            const taskId = 'T-AUDIT-TIMING';
            writeWorkflowConfig(tmpDir, false);
            writePreflight(reviewsDir, taskId, {
                mode: 'FULL_PATH',
                changed_files: ['src/gates/task-audit-summary.ts'],
                metrics: { changed_lines_total: 12 },
                required_reviews: { code: true }
            });
            writeArtifact(reviewsDir, taskId, '-doc-impact.json', {
                task_id: taskId,
                status: 'PASSED',
                outcome: 'PASS',
                decision: 'NO_DOC_UPDATES'
            });
            const preflightSha256 = computeFileSha256(path.join(reviewsDir, `${taskId}-preflight.json`));
            const reviewerIdentity = 'agent:code-reviewer';
            const fixture = writeCurrentIndependentReviewFixture({
                reviewsDir,
                taskId,
                preflightSha256,
                reviewerIdentity,
                provenance: null
            });
            const timing = {
                launch_prepared_at_utc: '2026-04-29T00:00:06.000Z',
                delegation_started_at_utc: '2026-04-29T00:00:07.000Z',
                launched_at_utc: '2026-04-29T00:00:07.000Z',
                launch_completed_at_utc: '2026-04-29T00:00:42.000Z',
                invocation_attested_at_utc: '2026-04-29T00:00:43.000Z',
                review_result_recorded_at_utc: '2026-04-29T00:01:00.000Z',
                review_output_source_mtime_utc: '2026-04-29T00:01:01.000Z'
            };
            const events = writeIntegrityEventSequence(eventsDir, taskId, [
                { event_type: 'TASK_MODE_ENTERED' },
                { event_type: 'RULE_PACK_LOADED' },
                { event_type: 'HANDSHAKE_DIAGNOSTICS_RECORDED' },
                { event_type: 'SHELL_SMOKE_PREFLIGHT_RECORDED' },
                { event_type: 'PREFLIGHT_CLASSIFIED' },
                { event_type: 'COMPILE_GATE_PASSED' },
                { event_type: 'REVIEW_PHASE_STARTED' },
                {
                    event_type: 'REVIEWER_INVOCATION_ATTESTED',
                    details: {
                        task_id: taskId,
                        review_type: 'code',
                        reviewer_execution_mode: 'delegated_subagent',
                        reviewer_identity: reviewerIdentity,
                        review_context_sha256: fixture.reviewContextSha256,
                        routing_event_sha256: 'd'.repeat(64),
                        execution_provider: 'GitHubCopilot',
                        provider: 'Claude',
                        reviewer_launch_tool: 'Codex',
                        provider_invocation_id: 'codex-subagent-run-123',
                        reviewer_launch_attestation_source: 'codex_subagent',
                        ...timing
                    }
                },
                { event_type: 'REVIEW_GATE_PASSED' },
                { event_type: 'DOC_IMPACT_ASSESSED' },
                { event_type: 'COMPLETION_GATE_PASSED' }
            ]);
            const invocationEvent = events.find((event) => event.event_type === 'REVIEWER_INVOCATION_ATTESTED');
            assert.ok(invocationEvent);
            const invocationIntegrity = invocationEvent.integrity as Record<string, unknown>;
            const reviewPath = path.join(reviewsDir, `${taskId}-code.md`);
            const receiptPath = path.join(reviewsDir, `${taskId}-code-receipt.json`);
            const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8')) as Record<string, unknown>;
            receipt.recorded_at_utc = timing.review_result_recorded_at_utc;
            receipt.review_result_recorded_at_utc = timing.review_result_recorded_at_utc;
            receipt.review_output_source_mtime_utc = timing.review_output_source_mtime_utc;
            receipt.review_output_path = reviewPath;
            receipt.review_output_sha256 = computeFileSha256(reviewPath);
            receipt.reviewer_provenance = {
                schema_version: 1,
                attestation_type: 'reviewer_invocation_attestation',
                controller_event_type: 'REVIEWER_INVOCATION_ATTESTED',
                task_sequence: invocationIntegrity.task_sequence,
                prev_event_sha256: invocationIntegrity.prev_event_sha256,
                event_sha256: invocationIntegrity.event_sha256,
                task_id: taskId,
                review_type: 'code',
                reviewer_execution_mode: 'delegated_subagent',
                reviewer_identity: reviewerIdentity,
                review_context_sha256: fixture.reviewContextSha256,
                routing_event_sha256: 'd'.repeat(64),
                launch_prepared_at_utc: timing.launch_prepared_at_utc,
                delegation_started_at_utc: timing.delegation_started_at_utc,
                launched_at_utc: timing.launched_at_utc,
                launch_completed_at_utc: timing.launch_completed_at_utc,
                invocation_attested_at_utc: timing.invocation_attested_at_utc
            };
            fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
            const duplicateReceipt = {
                ...receipt,
                recorded_at_utc: '2026-04-29T00:01:01.000Z',
                review_result_recorded_at_utc: '2026-04-29T00:01:01.000Z'
            };
            const duplicateReceiptText = `${JSON.stringify(duplicateReceipt, null, 2)}\n`;
            const duplicateReceiptSha256 = createHash('sha256').update(duplicateReceiptText, 'utf8').digest('hex');
            fs.writeFileSync(
                path.join(reviewsDir, `${taskId}-code-receipt-${duplicateReceiptSha256}.json`),
                duplicateReceiptText,
                'utf8'
            );

            const result = buildTaskAuditSummary({
                taskId,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            assert.equal(result.final_closeout.review_timing_audit?.entries.length, 1);
            const [entry] = result.final_closeout.review_timing_audit?.entries || [];
            assert.ok(entry);
            assert.equal(entry.review_type, 'code');
            assert.equal(entry.provider, 'GitHubCopilot');
            assert.equal(entry.provider_invocation_id, 'codex-subagent-run-123');
            assert.equal(entry.delegation_to_result_ms, 53000);
            assert.equal(entry.delegation_to_source_mtime_ms, 54000);
            assert.equal(entry.gate_finalize_ms, 18000);
            assert.equal(entry.launch_to_result_ms, 53000);
            assert.equal(entry.launch_to_source_mtime_ms, 54000);
            assert.equal(entry.hidden_timing_status, 'TRUSTED');
            assert.equal(entry.hidden_timing_distrust_code, null);
            const rendered = formatTaskAuditSummaryText(result);
            assert.ok(rendered.includes('Review timing audit: code(TRUSTED, delegation_to_result=53000ms'));
            assert.ok(rendered.includes('provider=GitHubCopilot provider_invocation=codex-subagent-run-123'));
            assert.ok(formatFinalCloseoutMarkdown(result.final_closeout).includes('Review timing audit: code(TRUSTED'));
        });

        it('excludes reused code, security, and performance receipts from final timing audit', () => {
            const repoRoot = makeReuseTempRepo();
            const taskId = 'T-AUDIT-REUSE-TIMING';
            const reviewsRoot = reuseReviewsRoot(repoRoot);
            const eventsRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'task-events');
            seedReuseStartedTask(repoRoot, taskId);
            writeReusePreflight(repoRoot, taskId, {
                ...REUSE_ALL_REVIEW_FLAGS,
                code: true,
                security: true,
                performance: true
            }, {
                includeDomainScopeFingerprints: true
            });
            seedReuseCompilePass(repoRoot, taskId);
            for (const reviewType of ['code', 'security', 'performance']) {
                writeReuseReviewEvidence(repoRoot, taskId, reviewType);
                markReuseReviewEvidenceAsStrictReuse(repoRoot, taskId, reviewType);
                clearCurrentReuseTimingForAudit(repoRoot, taskId, reviewType);
            }
            seedReuseCompilePass(repoRoot, taskId);
            for (const reviewType of ['code', 'security', 'performance']) {
                appendCurrentStrictReuseRecordedForAudit(repoRoot, taskId, reviewType);
            }
            writeArtifact(reviewsRoot, taskId, '-doc-impact.json', {
                task_id: taskId,
                status: 'PASSED',
                outcome: 'PASS',
                decision: 'NO_DOC_UPDATES'
            });

            const result = buildTaskAuditSummary({
                taskId,
                repoRoot,
                eventsRoot,
                reviewsRoot
            });

            const reusedEntries = (result.final_closeout.review_timing_audit?.entries || []).filter((entry) => (
                entry.reused_existing_review
            ));
            assert.equal(reusedEntries.length, 0);
            assert.deepEqual(
                [...new Set((result.final_closeout.review_timing_audit?.entries || []).map((entry) => entry.review_type))].sort(),
                ['code', 'performance', 'security']
            );
            const finalUserReport = formatFinalUserReport(result.final_closeout);
            assert.equal(finalUserReport.includes('timing looked unusual'), false);
            assert.equal(finalUserReport.includes('DISTRUSTED'), false);
        });

        it('excludes diverging reused receipt snapshots from final timing audit checks', () => {
            const repoRoot = makeReuseTempRepo();
            const taskId = 'T-AUDIT-REUSE-TAMPER';
            const reviewsRoot = reuseReviewsRoot(repoRoot);
            const eventsRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'task-events');
            seedReuseStartedTask(repoRoot, taskId);
            writeReusePreflight(repoRoot, taskId, { ...REUSE_ALL_REVIEW_FLAGS, code: true }, {
                includeDomainScopeFingerprints: true
            });
            seedReuseCompilePass(repoRoot, taskId);
            writeReuseReviewEvidence(repoRoot, taskId, 'code');
            markReuseReviewEvidenceAsStrictReuse(repoRoot, taskId, 'code');
            seedReuseCompilePass(repoRoot, taskId);
            appendCurrentStrictReuseRecordedForAudit(repoRoot, taskId, 'code');
            // A snapshot receipt that diverges from the canonical receipt content must
            // not inherit the canonical receipt's strict-reuse validation result.
            const canonicalReceiptPath = path.join(reviewsRoot, `${taskId}-code-receipt.json`);
            const tamperedReceipt = JSON.parse(fs.readFileSync(canonicalReceiptPath, 'utf8')) as Record<string, unknown>;
            tamperedReceipt.recorded_at_utc = '2099-01-01T00:00:00.000Z';
            tamperedReceipt.review_result_recorded_at_utc = '2099-01-01T00:00:00.000Z';
            const tamperedSnapshotName = `${taskId}-code-receipt-${'f'.repeat(64)}.json`;
            fs.writeFileSync(
                path.join(reviewsRoot, tamperedSnapshotName),
                `${JSON.stringify(tamperedReceipt, null, 2)}\n`,
                'utf8'
            );
            writeArtifact(reviewsRoot, taskId, '-doc-impact.json', {
                task_id: taskId,
                status: 'PASSED',
                outcome: 'PASS',
                decision: 'NO_DOC_UPDATES'
            });

            const result = buildTaskAuditSummary({
                taskId,
                repoRoot,
                eventsRoot,
                reviewsRoot
            });

            const reusedEntries = (result.final_closeout.review_timing_audit?.entries || []).filter((entry) => (
                entry.review_type === 'code' && entry.reused_existing_review
            ));
            assert.equal(reusedEntries.length, 0);
            assert.equal(formatFinalUserReport(result.final_closeout).includes('timing looked unusual'), false);
        });

        it('excludes reused receipts with missing source provenance from final timing checks', () => {
            const repoRoot = makeReuseTempRepo();
            const taskId = 'T-AUDIT-REUSE-MISSING-SOURCE';
            const reviewsRoot = reuseReviewsRoot(repoRoot);
            const eventsRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'task-events');
            seedReuseStartedTask(repoRoot, taskId);
            writeReusePreflight(repoRoot, taskId, { ...REUSE_ALL_REVIEW_FLAGS, code: true }, {
                includeDomainScopeFingerprints: true
            });
            seedReuseCompilePass(repoRoot, taskId);
            writeReuseReviewEvidence(repoRoot, taskId, 'code');
            markReuseReviewEvidenceAsStrictReuse(repoRoot, taskId, 'code');

            const receiptPath = path.join(reviewsRoot, `${taskId}-code-receipt.json`);
            const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8')) as Record<string, unknown>;
            const validCanonicalReceipt = structuredClone(receipt);
            delete receipt.reused_from_receipt_path;
            delete receipt.reused_from_receipt_sha256;
            fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
            clearCurrentReuseTimingForAudit(repoRoot, taskId, 'code');
            seedReuseCompilePass(repoRoot, taskId);
            appendCurrentStrictReuseRecordedForAudit(repoRoot, taskId, 'code');
            fs.writeFileSync(receiptPath, `${JSON.stringify(validCanonicalReceipt, null, 2)}\n`, 'utf8');

            const result = buildTaskAuditSummary({ taskId, repoRoot, eventsRoot, reviewsRoot });
            const reusedEntries = (result.final_closeout.review_timing_audit?.entries || []).filter((entry) => (
                entry.review_type === 'code' && entry.reused_existing_review
            ));
            assert.equal(reusedEntries.length, 0);
            assert.equal(formatFinalUserReport(result.final_closeout).includes('timing looked unusual'), false);
        });
    });
});
