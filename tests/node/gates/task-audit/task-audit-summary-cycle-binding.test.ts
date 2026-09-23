import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { getUnexpectedPostDoneWorkspaceFiles } from '../../../../src/gates/task-audit/task-audit-summary-drift';
import { buildLifecycleGateOutcomes, hasCurrentCycleReviewProgress } from '../../../../src/gates/task-audit/task-audit-summary-lifecycle';

import {
    fs,
    path,
    execFileSync,
    createHash,
    buildTaskAuditSummary,
    formatTaskAuditSummaryText,
    formatFinalCloseoutMarkdown,
    synchronizeFinalCloseoutArtifacts,
    getWorkspaceSnapshot,
    writeEvent,
    writePreflight,
    writeArtifact,
    computeFileSha256,
    writeWorkflowConfig,
    writePathsConfig,
    writePassedLifecycle,
    initGitRepo,
    makeTempDir} from './task-audit-summary-fixtures';

function seedProtectedDirtyBaselineCloseout(
    repoRoot: string,
    eventsDir: string,
    reviewsDir: string,
    taskId: string
): string {
    fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
    const implementationPath = path.join(repoRoot, 'src', 'app.ts');
    const baselineRelativePath = 'src/local-baseline.ts';
    const baselinePath = path.join(repoRoot, baselineRelativePath);
    fs.writeFileSync(implementationPath, 'export const value = 1;\n', 'utf8');
    fs.writeFileSync(baselinePath, 'export const localBaseline = 1;\n', 'utf8');
    initGitRepo(repoRoot);
    fs.appendFileSync(implementationPath, 'export const completedValue = 2;\n', 'utf8');
    fs.writeFileSync(baselinePath, 'export const localBaseline = 2;\n', 'utf8');
    const completedSnapshot = getWorkspaceSnapshot(
        repoRoot,
        'explicit_changed_files',
        true,
        ['src/app.ts']
    );
    writePassedLifecycle(eventsDir, taskId);
    writePreflight(reviewsDir, taskId, {
        changed_files: completedSnapshot.changed_files,
        metrics: {
            changed_lines_total: completedSnapshot.changed_lines_total,
            changed_files_sha256: completedSnapshot.changed_files_sha256,
            scope_content_sha256: completedSnapshot.scope_content_sha256
        },
        required_reviews: {},
        triggers: {
            dirty_workspace_protection_status: 'PASS',
            dirty_workspace_untouched_baseline_files: [baselineRelativePath],
            dirty_workspace_protected_files: [baselineRelativePath],
            dirty_workspace_protected_files_sha256: createHash('sha256')
                .update(baselineRelativePath, 'utf8')
                .digest('hex'),
            dirty_workspace_protected_file_hashes: {
                [baselineRelativePath]: computeFileSha256(baselinePath)
            }
        }
    });
    writeArtifact(reviewsDir, taskId, '-final-closeout.json', {
        status: 'READY',
        artifact_state: 'MATERIALIZED',
        implementation_summary: {
            changed_files: completedSnapshot.changed_files,
            changed_files_sha256: completedSnapshot.changed_files_sha256,
            scope_content_sha256: completedSnapshot.scope_content_sha256
        }
    });
    writeArtifact(reviewsDir, taskId, '-final-closeout.md', '# Final Closeout\n');
    return baselinePath;
}

function lifecycleEvent(eventType: string, taskSequence?: number): Record<string, unknown> {
    return {
        event_type: eventType,
        ...(taskSequence == null
            ? {}
            : {
                integrity: {
                    task_sequence: taskSequence
                }
            })
    };
}


describe('gates/task-audit-summary', () => {
    it('selects the latest gate failure by task sequence despite skewed timestamps', () => {
        const events = [
            { ...lifecycleEvent('COMPILE_GATE_PASSED', 1), timestamp_utc: '2026-01-01T00:00:01.000Z' },
            { ...lifecycleEvent('COMPILE_GATE_PASSED', 3), timestamp_utc: '2026-01-01T00:00:02.000Z' },
            { ...lifecycleEvent('COMPILE_GATE_FAILED', 4), timestamp_utc: '2026-01-01T00:00:03.000Z' },
            { ...lifecycleEvent('COMPILE_GATE_FAILED', 2), timestamp_utc: '2026-01-01T00:00:04.000Z' }
        ];
        const result = buildLifecycleGateOutcomes([
            { gate: 'compile-gate', pass_event: 'COMPILE_GATE_PASSED', fail_events: ['COMPILE_GATE_FAILED'] }
        ], events, null, '');

        assert.equal(result.gates[0].status, 'FAIL');
        assert.equal(result.gates[0].timestamp_utc, '2026-01-01T00:00:03.000Z');
    });

    it('retains the highest sequenced failure across unsequenced legacy events', () => {
        const events = [
            { ...lifecycleEvent('COMPILE_GATE_PASSED', 3), timestamp_utc: '2026-01-01T00:00:01.000Z' },
            { ...lifecycleEvent('COMPILE_GATE_FAILED', 4), timestamp_utc: '2026-01-01T00:00:02.000Z' },
            { ...lifecycleEvent('COMPILE_GATE_FAILED'), timestamp_utc: '2026-01-01T00:00:03.000Z' },
            { ...lifecycleEvent('COMPILE_GATE_FAILED', 2), timestamp_utc: '2026-01-01T00:00:04.000Z' }
        ];
        const result = buildLifecycleGateOutcomes([
            { gate: 'compile-gate', pass_event: 'COMPILE_GATE_PASSED', fail_events: ['COMPILE_GATE_FAILED'] }
        ], events, null, '');

        assert.equal(result.gates[0].status, 'FAIL');
        assert.equal(result.gates[0].timestamp_utc, '2026-01-01T00:00:02.000Z');
    });

    describe('hasCurrentCycleReviewProgress', () => {
        it('prefers task sequence over array or timestamp order', () => {
            assert.equal(hasCurrentCycleReviewProgress([
                lifecycleEvent('REVIEW_PHASE_STARTED', 11),
                lifecycleEvent('COMPILE_GATE_PASSED', 10)
            ]), true);
            assert.equal(hasCurrentCycleReviewProgress([
                lifecycleEvent('COMPILE_GATE_PASSED', 10),
                lifecycleEvent('REVIEW_PHASE_STARTED', 9)
            ]), false);
        });

        it('falls back to event order when sequence evidence is absent', () => {
            assert.equal(hasCurrentCycleReviewProgress([
                lifecycleEvent('REVIEW_PHASE_STARTED'),
                lifecycleEvent('COMPILE_GATE_PASSED')
            ]), false);
            assert.equal(hasCurrentCycleReviewProgress([
                lifecycleEvent('COMPILE_GATE_PASSED'),
                lifecycleEvent('REVIEW_PHASE_STARTED')
            ]), true);
        });

        it('falls back deterministically for mixed sequence evidence and recognizes reviewer activity', () => {
            assert.equal(hasCurrentCycleReviewProgress([
                lifecycleEvent('REVIEW_PHASE_STARTED'),
                lifecycleEvent('COMPILE_GATE_PASSED', 10)
            ]), false);
            assert.equal(hasCurrentCycleReviewProgress([
                lifecycleEvent('COMPILE_GATE_PASSED', 10),
                lifecycleEvent('REVIEW_PHASE_STARTED')
            ]), true);
            assert.equal(hasCurrentCycleReviewProgress([
                lifecycleEvent('REVIEW_PHASE_STARTED', 11),
                lifecycleEvent('COMPILE_GATE_PASSED')
            ]), false);
            assert.equal(hasCurrentCycleReviewProgress([
                lifecycleEvent('COMPILE_GATE_PASSED'),
                lifecycleEvent('REVIEW_PHASE_STARTED', 11)
            ]), true);
            assert.equal(hasCurrentCycleReviewProgress([
                lifecycleEvent('COMPILE_GATE_PASSED', 20),
                lifecycleEvent('REVIEWER_DELEGATION_STARTED', 21)
            ]), true);
            assert.equal(hasCurrentCycleReviewProgress([
                lifecycleEvent('COMPILE_GATE_PASSED', 20),
                lifecycleEvent('REVIEWER_INVOCATION_ATTESTED', 21)
            ]), true);
        });

        it('uses the latest compile boundary after failed and successful attempts', () => {
            const recompiled = [
                lifecycleEvent('COMPILE_GATE_FAILED', 4),
                lifecycleEvent('REVIEW_PHASE_STARTED', 5),
                lifecycleEvent('COMPILE_GATE_PASSED', 6)
            ];
            assert.equal(hasCurrentCycleReviewProgress(recompiled), false);
            assert.equal(hasCurrentCycleReviewProgress([
                ...recompiled,
                lifecycleEvent('REVIEW_PHASE_STARTED', 7)
            ]), true);
        });

        it('recognizes review restarts and completion attempts only after the current compile', () => {
            assert.equal(hasCurrentCycleReviewProgress([
                lifecycleEvent('REVIEW_CYCLE_RESTARTED', 3),
                lifecycleEvent('COMPILE_GATE_PASSED', 4)
            ]), false);
            assert.equal(hasCurrentCycleReviewProgress([
                lifecycleEvent('COMPILE_GATE_PASSED', 4),
                lifecycleEvent('REVIEW_CYCLE_RESTARTED', 5)
            ]), true);
            assert.equal(hasCurrentCycleReviewProgress([
                lifecycleEvent('COMPILE_GATE_PASSED', 4),
                lifecycleEvent('COMPLETION_GATE_FAILED', 5)
            ]), true);
            assert.equal(hasCurrentCycleReviewProgress([
                lifecycleEvent('COMPILE_GATE_PASSED', 4),
                lifecycleEvent('COMPLETION_GATE_PASSED', 5)
            ]), true);
        });
    });

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
        it('detects evidence artifacts', () => {
            fs.writeFileSync(path.join(eventsDir, `${TASK_ID}.jsonl`), '', 'utf8');
            writeArtifact(reviewsDir, TASK_ID, '-task-mode.json', { status: 'PASS' });
            writeArtifact(reviewsDir, TASK_ID, '-preflight.json', {
                changed_files: [],
                metrics: { changed_lines_total: 0 },
                required_reviews: {}
            });
            writeArtifact(reviewsDir, TASK_ID, '-coherent-cycle-restart.json', {
                schema_version: 1,
                event_source: 'restart-coherent-cycle',
                status: 'PASSED'
            });

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            const taskModeEvidence = result.evidence.find(e => e.kind === 'task-mode');
            assert.ok(taskModeEvidence);
            assert.equal(taskModeEvidence.exists, true);
            assert.ok(taskModeEvidence.sha256);

            const compileEvidence = result.evidence.find(e => e.kind === 'compile-gate');
            assert.ok(compileEvidence);
            assert.equal(compileEvidence.exists, false);
            assert.equal(compileEvidence.sha256, null);
            const restartEvidence = result.evidence.find(e => e.kind === 'coherent-cycle-restart');
            assert.ok(restartEvidence);
            assert.equal(restartEvidence.exists, true);
            assert.ok(restartEvidence.sha256);
        });

        it('returns INCOMPLETE when completion gate is present but supporting lifecycle evidence is missing', () => {
            const now = new Date().toISOString();
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: new Date(Date.parse(now) - 1000).toISOString(),
                task_id: TASK_ID,
                event_type: 'COMPILE_GATE_PASSED',
                outcome: 'PASS',
                actor: 'gate',
                message: 'Compile gate passed.'
            });
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: now,
                task_id: TASK_ID,
                event_type: 'COMPLETION_GATE_PASSED',
                outcome: 'PASS',
                actor: 'gate',
                message: 'Completion gate passed.'
            });
            writePreflight(reviewsDir, TASK_ID, {
                changed_files: [],
                metrics: { changed_lines_total: 0 },
                required_reviews: {}
            });

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            assert.equal(result.status, 'INCOMPLETE');
            assert.equal(result.final_report_contract.status, 'NOT_READY');
            assert.ok(result.final_report_contract.blocker?.includes('supporting lifecycle evidence is incomplete'));
        });

        it('keeps historical completed tasks green when live full-suite validation is enabled later', () => {
            const now = new Date().toISOString();
            writeWorkflowConfig(tmpDir, true);
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: now,
                task_id: TASK_ID,
                event_type: 'COMPLETION_GATE_PASSED',
                outcome: 'PASS',
                actor: 'gate',
                message: 'Completion gate passed.'
            });
            writePreflight(reviewsDir, TASK_ID, {
                changed_files: [],
                metrics: { changed_lines_total: 0 },
                required_reviews: {}
            });

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            assert.equal(result.status, 'PASS');
            assert.equal(result.final_report_contract.status, 'READY');
            assert.equal(result.gates.some((gate) => gate.gate === 'full-suite-validation'), false);
            assert.equal(result.blockers.some((blocker) => blocker.gate === 'full-suite-validation'), false);
        });

        it('preserves staged preflight scope hashes in final closeout when worktree content differs', () => {
            fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
            fs.writeFileSync(path.join(tmpDir, 'src', 'app.ts'), 'export const value = 1;\n', 'utf8');
            initGitRepo(tmpDir);
            fs.appendFileSync(path.join(tmpDir, 'src', 'app.ts'), 'export const stagedValue = 2;\n', 'utf8');
            execFileSync('git', ['add', 'src/app.ts'], { cwd: tmpDir, stdio: 'ignore' });
            const stagedSnapshot = getWorkspaceSnapshot(tmpDir, 'git_staged_only', false, []);
            fs.appendFileSync(path.join(tmpDir, 'src', 'app.ts'), 'export const unstagedSibling = 3;\n', 'utf8');
            const worktreeSnapshot = getWorkspaceSnapshot(tmpDir, 'explicit_changed_files', true, ['src/app.ts']);
            const now = new Date().toISOString();
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: now,
                task_id: TASK_ID,
                event_type: 'COMPLETION_GATE_PASSED',
                outcome: 'PASS',
                actor: 'gate',
                message: 'Completion gate passed.'
            });
            writePreflight(reviewsDir, TASK_ID, {
                task_id: TASK_ID,
                detection_source: stagedSnapshot.detection_source,
                include_untracked: stagedSnapshot.include_untracked,
                use_staged: stagedSnapshot.use_staged,
                changed_files: stagedSnapshot.changed_files,
                metrics: {
                    changed_lines_total: stagedSnapshot.changed_lines_total,
                    changed_files_sha256: stagedSnapshot.changed_files_sha256,
                    scope_content_sha256: stagedSnapshot.scope_content_sha256,
                    scope_sha256: stagedSnapshot.scope_sha256
                },
                required_reviews: {}
            });

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            assert.equal(result.final_closeout.implementation_summary.audited_scope_provenance?.use_staged, true);
            assert.equal(
                result.final_closeout.implementation_summary.audited_scope_provenance?.scope_content_sha256,
                stagedSnapshot.scope_content_sha256
            );
            assert.equal(result.final_closeout.implementation_summary.scope_content_sha256, stagedSnapshot.scope_content_sha256);
            assert.notEqual(result.final_closeout.implementation_summary.scope_content_sha256, worktreeSnapshot.scope_content_sha256);
        });

        it('filters only a hash-identical authenticated dirty baseline after DONE', () => {
            const baselinePath = seedProtectedDirtyBaselineCloseout(tmpDir, eventsDir, reviewsDir, TASK_ID);
            const preflightPath = path.join(reviewsDir, `${TASK_ID}-preflight.json`);
            const inspectUnexpectedFiles = () => {
                const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
                const currentSnapshot = getWorkspaceSnapshot(tmpDir, 'git_auto', true, []);
                return getUnexpectedPostDoneWorkspaceFiles(
                    tmpDir,
                    currentSnapshot.changed_files,
                    ['src/app.ts'],
                    preflight
                );
            };

            assert.deepEqual(inspectUnexpectedFiles(), {
                unexpectedFiles: [],
                protectedBaselineIntegrityError: false
            });
            fs.appendFileSync(baselinePath, 'export const postDoneDrift = 3;\n', 'utf8');

            const changedResult = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            const blocker = changedResult.blockers.find((entry) => entry.gate === 'post-done-drift');
            assert.ok(blocker);
            assert.match(blocker.reason, /src\/local-baseline\.ts/);

            fs.writeFileSync(baselinePath, 'export const localBaseline = 1;\n', 'utf8');
            assert.deepEqual(inspectUnexpectedFiles().unexpectedFiles, ['src/local-baseline.ts']);

            fs.writeFileSync(baselinePath, 'export const localBaseline = 2;\n', 'utf8');
            fs.unlinkSync(baselinePath);
            assert.deepEqual(inspectUnexpectedFiles().unexpectedFiles, ['src/local-baseline.ts']);

            fs.writeFileSync(baselinePath, 'export const localBaseline = 2;\n', 'utf8');
            const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
            preflight.detection_source = 'git_staged_only';
            preflight.include_untracked = false;
            const triggers = preflight.triggers as Record<string, unknown>;
            triggers.dirty_workspace_protected_files = ['src/local-baseline.ts', 'src/deleted-untracked.ts'];
            triggers.dirty_workspace_protected_files_sha256 = createHash('sha256')
                .update(['src/local-baseline.ts', 'src/deleted-untracked.ts'].sort().join('\n'), 'utf8')
                .digest('hex');
            triggers.dirty_workspace_protected_file_hashes = {
                'src/local-baseline.ts': computeFileSha256(baselinePath)
            };
            writeArtifact(reviewsDir, TASK_ID, '-preflight.json', preflight);
            assert.deepEqual(inspectUnexpectedFiles().unexpectedFiles, ['src/deleted-untracked.ts']);

            triggers.dirty_workspace_protected_files = ['src/local-baseline.ts'];
            triggers.dirty_workspace_protected_files_sha256 = createHash('sha256')
                .update('src/local-baseline.ts', 'utf8')
                .digest('hex');
            fs.writeFileSync(path.join(tmpDir, 'src', 'post-done-untracked.ts'), 'export const drift = true;\n', 'utf8');
            writeArtifact(reviewsDir, TASK_ID, '-preflight.json', preflight);
            assert.deepEqual(inspectUnexpectedFiles().unexpectedFiles, ['src/post-done-untracked.ts']);

            fs.unlinkSync(path.join(tmpDir, 'src', 'post-done-untracked.ts'));
            triggers.dirty_workspace_protected_files_sha256 = 'malformed';
            writeArtifact(reviewsDir, TASK_ID, '-preflight.json', preflight);
            const malformedScopeHashResult = inspectUnexpectedFiles();
            assert.equal(malformedScopeHashResult.protectedBaselineIntegrityError, true);
            assert.deepEqual(malformedScopeHashResult.unexpectedFiles, ['src/local-baseline.ts']);

            triggers.dirty_workspace_protected_files_sha256 = createHash('sha256')
                .update('src/local-baseline.ts', 'utf8')
                .digest('hex');
            triggers.dirty_workspace_protected_files = [];
            writeArtifact(reviewsDir, TASK_ID, '-preflight.json', preflight);
            assert.equal(inspectUnexpectedFiles().protectedBaselineIntegrityError, true);
        });

        it('blocks final closeout when tracked post-DONE drift is outside audited scope', () => {
            fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
            fs.writeFileSync(path.join(tmpDir, 'src', 'app.ts'), 'export const value = 1;\n', 'utf8');
            initGitRepo(tmpDir);
            fs.appendFileSync(path.join(tmpDir, 'src', 'app.ts'), 'export const completedValue = 2;\n', 'utf8');
            const now = new Date().toISOString();
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: now,
                task_id: TASK_ID,
                event_type: 'COMPLETION_GATE_PASSED',
                outcome: 'PASS',
                actor: 'gate',
                message: 'Completion gate passed.'
            });
            writePreflight(reviewsDir, TASK_ID, {
                changed_files: ['src/app.ts'],
                metrics: { changed_lines_total: 1 },
                required_reviews: {}
            });
            writeArtifact(reviewsDir, TASK_ID, '-final-closeout.json', {
                status: 'READY',
                artifact_state: 'MATERIALIZED'
            });
            writeArtifact(reviewsDir, TASK_ID, '-final-closeout.md', '# Final Closeout\n');
            fs.writeFileSync(path.join(tmpDir, 'src', 'post-done-drift.ts'), 'export const drift = true;\n', 'utf8');

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            assert.equal(result.status, 'BLOCKED');
            assert.equal(result.final_report_contract.status, 'NOT_READY');
            assert.ok(result.blockers.some((blocker) => blocker.gate === 'post-done-drift'));
            assert.match(result.final_report_contract.blocker || '', /post-DONE workspace drift/i);

            synchronizeFinalCloseoutArtifacts(result);

            assert.equal(fs.existsSync(path.join(reviewsDir, `${TASK_ID}-final-closeout.json`)), true);
            assert.equal(fs.existsSync(path.join(reviewsDir, `${TASK_ID}-final-closeout.md`)), true);
            assert.equal(result.final_closeout.artifact_state, 'MATERIALIZED');
            assert.equal(result.evidence.find((entry) => entry.kind === 'final-closeout-json')?.exists, true);
        });

        it('blocks final closeout when tracked post-DONE drift changes an audited file', () => {
            fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
            fs.writeFileSync(path.join(tmpDir, 'src', 'app.ts'), 'export const value = 1;\n', 'utf8');
            initGitRepo(tmpDir);
            fs.appendFileSync(path.join(tmpDir, 'src', 'app.ts'), 'export const completedValue = 2;\n', 'utf8');
            const completedSnapshot = getWorkspaceSnapshot(tmpDir, 'git_auto', true, []);
            const now = new Date().toISOString();
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: now,
                task_id: TASK_ID,
                event_type: 'COMPLETION_GATE_PASSED',
                outcome: 'PASS',
                actor: 'gate',
                message: 'Completion gate passed.'
            });
            writePreflight(reviewsDir, TASK_ID, {
                changed_files: completedSnapshot.changed_files,
                metrics: {
                    changed_lines_total: completedSnapshot.changed_lines_total,
                    changed_files_sha256: completedSnapshot.changed_files_sha256,
                    scope_content_sha256: completedSnapshot.scope_content_sha256
                },
                required_reviews: {}
            });
            writeArtifact(reviewsDir, TASK_ID, '-final-closeout.json', {
                status: 'READY',
                artifact_state: 'MATERIALIZED',
                implementation_summary: {
                    changed_files: completedSnapshot.changed_files,
                    changed_files_sha256: completedSnapshot.changed_files_sha256,
                    scope_content_sha256: completedSnapshot.scope_content_sha256
                }
            });
            writeArtifact(reviewsDir, TASK_ID, '-final-closeout.md', '# Final Closeout\n');
            fs.appendFileSync(path.join(tmpDir, 'src', 'app.ts'), 'export const drift = 3;\n', 'utf8');

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            assert.equal(result.status, 'BLOCKED');
            assert.equal(result.final_report_contract.status, 'NOT_READY');
            const blocker = result.blockers.find((entry) => entry.gate === 'post-done-drift');
            assert.ok(blocker);
            assert.match(blocker.reason, /changed audited closeout content/);
            assert.match(blocker.reason, /src\/app\.ts/);
        });

        it('keeps final closeout ready after the exact audited diff is committed', () => {
            fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
            fs.writeFileSync(path.join(tmpDir, 'src', 'app.ts'), 'export const value = 1;\n', 'utf8');
            initGitRepo(tmpDir);
            fs.appendFileSync(path.join(tmpDir, 'src', 'app.ts'), 'export const completedValue = 2;\n', 'utf8');
            const completedSnapshot = getWorkspaceSnapshot(tmpDir, 'git_auto', true, []);
            writePassedLifecycle(eventsDir, TASK_ID);
            writePreflight(reviewsDir, TASK_ID, {
                changed_files: completedSnapshot.changed_files,
                metrics: {
                    changed_lines_total: completedSnapshot.changed_lines_total,
                    changed_files_sha256: completedSnapshot.changed_files_sha256,
                    scope_content_sha256: completedSnapshot.scope_content_sha256
                },
                required_reviews: {}
            });
            const ready = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });
            synchronizeFinalCloseoutArtifacts(ready);
            execFileSync('git', ['add', 'src/app.ts'], { cwd: tmpDir, stdio: 'ignore' });
            execFileSync('git', ['commit', '-m', 'commit completed scope'], { cwd: tmpDir, stdio: 'ignore' });

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            assert.equal(result.status, 'PASS');
            assert.equal(result.blockers.some((entry) => entry.gate === 'post-done-drift'), false);
            assert.equal(result.final_report_contract.status, 'READY');

            fs.appendFileSync(path.join(tmpDir, 'src', 'app.ts'), 'export const laterValue = 3;\n', 'utf8');
            execFileSync('git', ['add', 'src/app.ts'], { cwd: tmpDir, stdio: 'ignore' });
            execFileSync('git', ['commit', '-m', 'change completed scope later'], { cwd: tmpDir, stdio: 'ignore' });

            const drifted = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });
            const blocker = drifted.blockers.find((entry) => entry.gate === 'post-done-drift');
            assert.ok(blocker);
            assert.match(blocker.reason, /scope_content_sha256/);
        });

        it('blocks final closeout when an audited scope hash is missing', () => {
            fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
            fs.writeFileSync(path.join(tmpDir, 'src', 'app.ts'), 'export const value = 1;\n', 'utf8');
            initGitRepo(tmpDir);
            fs.appendFileSync(path.join(tmpDir, 'src', 'app.ts'), 'export const completedValue = 2;\n', 'utf8');
            const completedSnapshot = getWorkspaceSnapshot(tmpDir, 'git_auto', true, []);
            writePassedLifecycle(eventsDir, TASK_ID);
            writePreflight(reviewsDir, TASK_ID, {
                changed_files: completedSnapshot.changed_files,
                metrics: {
                    changed_lines_total: completedSnapshot.changed_lines_total,
                    changed_files_sha256: completedSnapshot.changed_files_sha256,
                    scope_content_sha256: completedSnapshot.scope_content_sha256
                },
                required_reviews: {}
            });
            const ready = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });
            synchronizeFinalCloseoutArtifacts(ready);
            const closeoutPath = path.join(reviewsDir, `${TASK_ID}-final-closeout.json`);
            const closeout = JSON.parse(fs.readFileSync(closeoutPath, 'utf8')) as Record<string, unknown>;
            delete (closeout.implementation_summary as Record<string, unknown>).scope_content_sha256;
            writeArtifact(reviewsDir, TASK_ID, '-final-closeout.json', closeout);

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            const blocker = result.blockers.find((entry) => entry.gate === 'post-done-drift');
            assert.ok(blocker);
            assert.match(blocker.reason, /missing valid audited scope hashes/);
        });

        it('blocks final closeout when tracked post-DONE drift changes a doc-impact audited file', () => {
            fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
            fs.mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
            fs.writeFileSync(path.join(tmpDir, 'src', 'app.ts'), 'export const value = 1;\n', 'utf8');
            initGitRepo(tmpDir);
            fs.appendFileSync(path.join(tmpDir, 'src', 'app.ts'), 'export const completedValue = 2;\n', 'utf8');
            fs.writeFileSync(path.join(tmpDir, 'docs', 'cli-reference.md'), '# CLI\n\nDocumented closeout.\n', 'utf8');
            const now = new Date().toISOString();
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: now,
                task_id: TASK_ID,
                event_type: 'COMPLETION_GATE_PASSED',
                outcome: 'PASS',
                actor: 'gate',
                message: 'Completion gate passed.'
            });
            writePreflight(reviewsDir, TASK_ID, {
                changed_files: ['src/app.ts'],
                metrics: { changed_lines_total: 1 },
                required_reviews: {}
            });
            writeArtifact(reviewsDir, TASK_ID, '-doc-impact.json', {
                status: 'PASSED',
                outcome: 'PASS',
                decision: 'DOCS_UPDATED',
                behavior_changed: false,
                changelog_updated: false,
                docs_updated: ['docs/cli-reference.md']
            });

            const ready = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });
            synchronizeFinalCloseoutArtifacts(ready);
            fs.appendFileSync(path.join(tmpDir, 'docs', 'cli-reference.md'), '\nPost-DONE drift.\n', 'utf8');

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            assert.equal(result.status, 'BLOCKED');
            const blocker = result.blockers.find((entry) => entry.gate === 'post-done-drift');
            assert.ok(blocker);
            assert.match(blocker.reason, /changed audited closeout content/);
            assert.match(blocker.reason, /docs\/cli-reference\.md/);
        });

        it('blocks staged-scope final closeout when post-DONE drift changes a doc-impact audited file', () => {
            fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
            fs.mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
            fs.writeFileSync(path.join(tmpDir, 'src', 'app.ts'), 'export const value = 1;\n', 'utf8');
            initGitRepo(tmpDir);
            fs.appendFileSync(path.join(tmpDir, 'src', 'app.ts'), 'export const stagedValue = 2;\n', 'utf8');
            execFileSync('git', ['add', 'src/app.ts'], { cwd: tmpDir, stdio: 'ignore' });
            const stagedSnapshot = getWorkspaceSnapshot(tmpDir, 'git_staged_only', false, []);
            fs.writeFileSync(path.join(tmpDir, 'docs', 'cli-reference.md'), '# CLI\n\nDocumented closeout.\n', 'utf8');
            const now = new Date().toISOString();
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: now,
                task_id: TASK_ID,
                event_type: 'COMPLETION_GATE_PASSED',
                outcome: 'PASS',
                actor: 'gate',
                message: 'Completion gate passed.'
            });
            writePreflight(reviewsDir, TASK_ID, {
                task_id: TASK_ID,
                detection_source: stagedSnapshot.detection_source,
                include_untracked: stagedSnapshot.include_untracked,
                use_staged: stagedSnapshot.use_staged,
                changed_files: stagedSnapshot.changed_files,
                metrics: {
                    changed_lines_total: stagedSnapshot.changed_lines_total,
                    changed_files_sha256: stagedSnapshot.changed_files_sha256,
                    scope_content_sha256: stagedSnapshot.scope_content_sha256,
                    scope_sha256: stagedSnapshot.scope_sha256
                },
                required_reviews: {}
            });
            writeArtifact(reviewsDir, TASK_ID, '-doc-impact.json', {
                status: 'PASSED',
                outcome: 'PASS',
                decision: 'DOCS_UPDATED',
                behavior_changed: false,
                changelog_updated: false,
                docs_updated: ['docs/cli-reference.md']
            });

            const ready = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });
            synchronizeFinalCloseoutArtifacts(ready);
            fs.appendFileSync(path.join(tmpDir, 'docs', 'cli-reference.md'), '\nPost-DONE drift.\n', 'utf8');

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            assert.equal(result.status, 'BLOCKED');
            const blocker = result.blockers.find((entry) => entry.gate === 'post-done-drift');
            assert.ok(blocker);
            assert.match(blocker.reason, /changed audited closeout extra scope/);
            assert.match(blocker.reason, /docs\/cli-reference\.md/);
        });

        it('blocks final closeout when post-DONE doc-impact artifact changes the audited file list in a clean worktree', () => {
            fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
            fs.mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
            fs.writeFileSync(path.join(tmpDir, 'src', 'app.ts'), 'export const value = 1;\n', 'utf8');
            initGitRepo(tmpDir);
            fs.appendFileSync(path.join(tmpDir, 'src', 'app.ts'), 'export const completedValue = 2;\n', 'utf8');
            fs.writeFileSync(path.join(tmpDir, 'docs', 'cli-reference.md'), '# CLI\n\nDocumented closeout.\n', 'utf8');
            fs.writeFileSync(path.join(tmpDir, 'docs', 'extra.md'), '# Extra\n\nTracked but not audited.\n', 'utf8');
            const now = new Date().toISOString();
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: now,
                task_id: TASK_ID,
                event_type: 'COMPLETION_GATE_PASSED',
                outcome: 'PASS',
                actor: 'gate',
                message: 'Completion gate passed.'
            });
            writePreflight(reviewsDir, TASK_ID, {
                changed_files: ['src/app.ts'],
                metrics: { changed_lines_total: 1 },
                required_reviews: {}
            });
            writeArtifact(reviewsDir, TASK_ID, '-doc-impact.json', {
                status: 'PASSED',
                outcome: 'PASS',
                decision: 'DOCS_UPDATED',
                behavior_changed: false,
                changelog_updated: false,
                docs_updated: ['docs/cli-reference.md']
            });

            const ready = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });
            synchronizeFinalCloseoutArtifacts(ready);
            execFileSync('git', ['add', 'src/app.ts', 'docs/cli-reference.md', 'docs/extra.md'], { cwd: tmpDir, stdio: 'ignore' });
            execFileSync('git', ['commit', '-m', 'complete task'], { cwd: tmpDir, stdio: 'ignore' });
            writeArtifact(reviewsDir, TASK_ID, '-doc-impact.json', {
                status: 'PASSED',
                outcome: 'PASS',
                decision: 'DOCS_UPDATED',
                behavior_changed: false,
                changelog_updated: false,
                docs_updated: ['docs/cli-reference.md', 'docs/extra.md']
            });

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            assert.equal(result.status, 'BLOCKED');
            const blocker = result.blockers.find((entry) => entry.gate === 'post-done-drift');
            assert.ok(blocker);
            assert.match(blocker.reason, /changed audited closeout content/);
            assert.match(blocker.reason, /docs\/extra\.md/);
        });

        it('blocks final closeout when post-DONE workspace inspection fails in a git worktree', () => {
            fs.mkdirSync(path.join(tmpDir, '.git'), { recursive: true });
            const now = new Date().toISOString();
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: now,
                task_id: TASK_ID,
                event_type: 'COMPLETION_GATE_PASSED',
                outcome: 'PASS',
                actor: 'gate',
                message: 'Completion gate passed.'
            });
            writePreflight(reviewsDir, TASK_ID, {
                changed_files: ['src/app.ts'],
                metrics: { changed_lines_total: 1 },
                required_reviews: {}
            });
            writeArtifact(reviewsDir, TASK_ID, '-final-closeout.json', {
                status: 'READY',
                artifact_state: 'MATERIALIZED'
            });
            writeArtifact(reviewsDir, TASK_ID, '-final-closeout.md', '# Final Closeout\n');

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            assert.equal(result.status, 'BLOCKED');
            assert.equal(result.final_report_contract.status, 'NOT_READY');
            const blocker = result.blockers.find((entry) => entry.gate === 'post-done-drift');
            assert.ok(blocker);
            assert.match(blocker.reason, /Unable to inspect tracked post-DONE workspace drift/);
            assert.match(result.final_report_contract.blocker || '', /final closeout is blocked/i);
        });

        it('includes doc-impact docs_updated paths in final changed-files summaries', () => {
            const now = new Date().toISOString();
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: now,
                task_id: TASK_ID,
                event_type: 'COMPLETION_GATE_PASSED',
                outcome: 'PASS',
                actor: 'gate',
                message: 'Completion gate passed.'
            });
            writePreflight(reviewsDir, TASK_ID, {
                changed_files: ['src/gates/doc-impact.ts'],
                metrics: { changed_lines_total: 7 },
                required_reviews: {}
            });
            writeArtifact(reviewsDir, TASK_ID, '-doc-impact.json', {
                status: 'PASSED',
                outcome: 'PASS',
                decision: 'DOCS_UPDATED',
                behavior_changed: true,
                changelog_updated: true,
                docs_updated: [
                    'docs/cli-reference.md',
                    'CHANGELOG.md',
                    'src/gates/doc-impact.ts'
                ]
            });

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });
            const rendered = formatTaskAuditSummaryText(result);

            assert.deepEqual(result.changed_files, [
                'src/gates/doc-impact.ts',
                'docs/cli-reference.md',
                'CHANGELOG.md'
            ]);
            assert.equal(result.changed_files_count, 3);
            assert.equal(result.final_closeout.implementation_summary.changed_files_count, 3);
            assert.deepEqual(result.final_closeout.docs.docs_updated, [
                'docs/cli-reference.md',
                'CHANGELOG.md',
                'src/gates/doc-impact.ts'
            ]);
            assert.ok(rendered.includes('ChangedFiles: 3'));
            assert.ok(rendered.includes('PreflightChangedLines: 7'));
            assert.ok(!rendered.includes('ChangedFiles: 3 (7 lines)'));
            assert.ok(rendered.includes('  - docs/cli-reference.md'));
            assert.ok(rendered.includes('  - CHANGELOG.md'));
        });

        it('accepts configured extensionless ordinary docs in final changed-files summaries', () => {
            const now = new Date().toISOString();
            writePathsConfig(tmpDir, {
                ordinary_doc_paths: ['BACKLOG']
            });
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: now,
                task_id: TASK_ID,
                event_type: 'COMPLETION_GATE_PASSED',
                outcome: 'PASS',
                actor: 'gate',
                message: 'Completion gate passed.'
            });
            writePreflight(reviewsDir, TASK_ID, {
                changed_files: ['src/gates/doc-impact.ts'],
                metrics: { changed_lines_total: 7 },
                required_reviews: {}
            });
            writeArtifact(reviewsDir, TASK_ID, '-doc-impact.json', {
                status: 'PASSED',
                outcome: 'PASS',
                decision: 'DOCS_UPDATED',
                behavior_changed: true,
                changelog_updated: false,
                docs_updated: [
                    'BACKLOG'
                ]
            });

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            assert.equal(result.status, 'PASS');
            assert.deepEqual(result.changed_files, [
                'src/gates/doc-impact.ts',
                'BACKLOG'
            ]);
            assert.equal(result.changed_files_count, 2);
        });

        it('blocks configured dependency paths in final changed-files summaries', () => {
            const now = new Date().toISOString();
            writePathsConfig(tmpDir, {
                ordinary_doc_paths: ['requirements.txt']
            });
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: now,
                task_id: TASK_ID,
                event_type: 'COMPLETION_GATE_PASSED',
                outcome: 'PASS',
                actor: 'gate',
                message: 'Completion gate passed.'
            });
            writePreflight(reviewsDir, TASK_ID, {
                changed_files: ['src/gates/doc-impact.ts'],
                metrics: { changed_lines_total: 7 },
                required_reviews: {}
            });
            writeArtifact(reviewsDir, TASK_ID, '-doc-impact.json', {
                status: 'PASSED',
                outcome: 'PASS',
                decision: 'DOCS_UPDATED',
                behavior_changed: true,
                changelog_updated: false,
                docs_updated: [
                    'requirements.txt'
                ]
            });

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            assert.equal(result.status, 'BLOCKED');
            assert.equal(result.final_report_contract.status, 'NOT_READY');
            assert.deepEqual(result.changed_files, ['src/gates/doc-impact.ts']);
            assert.ok(result.blockers.some((blocker) =>
                blocker.gate === 'doc-impact-gate'
                && blocker.reason.includes("docs_updated contains non-documentation path 'requirements.txt'")
            ));
        });

        it('blocks final changed-files summaries when docs_updated declares new non-doc paths', () => {
            const now = new Date().toISOString();
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: now,
                task_id: TASK_ID,
                event_type: 'COMPLETION_GATE_PASSED',
                outcome: 'PASS',
                actor: 'gate',
                message: 'Completion gate passed.'
            });
            writePreflight(reviewsDir, TASK_ID, {
                changed_files: ['src/gates/doc-impact.ts'],
                metrics: { changed_lines_total: 7 },
                required_reviews: {}
            });
            writeArtifact(reviewsDir, TASK_ID, '-doc-impact.json', {
                status: 'PASSED',
                outcome: 'PASS',
                decision: 'DOCS_UPDATED',
                behavior_changed: true,
                changelog_updated: true,
                docs_updated: [
                    'docs/cli-reference.md',
                    'src/new-runtime.ts'
                ]
            });

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            assert.equal(result.status, 'BLOCKED');
            assert.equal(result.final_report_contract.status, 'NOT_READY');
            assert.deepEqual(result.changed_files, [
                'src/gates/doc-impact.ts',
                'docs/cli-reference.md'
            ]);
            assert.equal(result.changed_files.includes('src/new-runtime.ts'), false);
            assert.ok(result.blockers.some((blocker) =>
                blocker.gate === 'doc-impact-gate'
                && blocker.reason.includes("docs_updated contains non-documentation path 'src/new-runtime.ts'")
            ));
        });

        it('treats downstream gate passes as stale after a newer compile cycle begins', () => {
            const compileOne = '2026-01-01T00:00:01.000Z';
            const reviewPhase = '2026-01-01T00:00:02.000Z';
            const reviewGate = '2026-01-01T00:00:03.000Z';
            const docImpact = '2026-01-01T00:00:04.000Z';
            const completion = '2026-01-01T00:00:05.000Z';
            const compileTwo = '2026-01-01T00:00:06.000Z';

            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: compileOne,
                task_id: TASK_ID,
                event_type: 'COMPILE_GATE_PASSED',
                outcome: 'PASS',
                actor: 'gate',
                message: 'Compile gate passed for the earlier cycle.'
            });
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: reviewPhase,
                task_id: TASK_ID,
                event_type: 'REVIEW_PHASE_STARTED',
                outcome: 'PASS',
                actor: 'gate',
                message: 'Review phase started for the earlier cycle.'
            });
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: reviewGate,
                task_id: TASK_ID,
                event_type: 'REVIEW_GATE_PASSED',
                outcome: 'PASS',
                actor: 'gate',
                message: 'Review gate passed for the earlier cycle.'
            });
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: docImpact,
                task_id: TASK_ID,
                event_type: 'DOC_IMPACT_ASSESSED',
                outcome: 'PASS',
                actor: 'gate',
                message: 'Doc impact recorded for the earlier cycle.'
            });
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: completion,
                task_id: TASK_ID,
                event_type: 'COMPLETION_GATE_PASSED',
                outcome: 'PASS',
                actor: 'gate',
                message: 'Completion gate passed for the earlier cycle.'
            });
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: compileTwo,
                task_id: TASK_ID,
                event_type: 'COMPILE_GATE_PASSED',
                outcome: 'PASS',
                actor: 'gate',
                message: 'A newer compile cycle started after the earlier completion.'
            });
            writeArtifact(reviewsDir, TASK_ID, '-compile-gate.json', {
                timestamp_utc: compileTwo,
                preflight_path: path.join(reviewsDir, `${TASK_ID}-preflight.json`),
                preflight_hash_sha256: 'current-cycle'
            });
            writePreflight(reviewsDir, TASK_ID, {
                changed_files: ['src/gates/task-audit-summary.ts'],
                metrics: { changed_lines_total: 18 },
                required_reviews: {}
            });

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            assert.equal(result.status, 'INCOMPLETE');
            assert.equal(result.final_report_contract.status, 'NOT_READY');
            assert.equal(result.gates.find((gate) => gate.gate === 'compile-gate')?.status, 'PASS');
            assert.equal(result.gates.find((gate) => gate.gate === 'required-reviews-check')?.status, 'MISSING');
            assert.equal(result.gates.find((gate) => gate.gate === 'doc-impact-gate')?.status, 'MISSING');
            assert.equal(result.gates.find((gate) => gate.gate === 'completion-gate')?.status, 'MISSING');
            assert.ok(result.final_report_contract.blocker);
        });

        it('does not let stale required-review receipts block a freshly recompiled cycle', () => {
            const reviewContent = '# Code Review\nREVIEW PASSED';
            writeArtifact(reviewsDir, TASK_ID, '-code.md', reviewContent);
            writeArtifact(reviewsDir, TASK_ID, '-code-receipt.json', {
                schema_version: 2,
                task_id: TASK_ID,
                review_type: 'code',
                review_artifact_sha256: 'stale-hash',
                reviewer_execution_mode: 'delegated_subagent',
                reviewer_identity: 'agent:code-reviewer',
                trust_level: 'LOCAL_AUDITED',
                recorded_at_utc: new Date().toISOString()
            });
            writePreflight(reviewsDir, TASK_ID, {
                changed_files: ['src/gates/task-audit-summary.ts'],
                metrics: { changed_lines_total: 18 },
                required_reviews: { code: true }
            });
            writeArtifact(reviewsDir, TASK_ID, '-compile-gate.json', {
                timestamp_utc: '2026-01-01T00:00:06.000Z',
                preflight_path: path.join(reviewsDir, `${TASK_ID}-preflight.json`),
                preflight_hash_sha256: 'current-cycle'
            });
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: '2026-01-01T00:00:01.000Z',
                task_id: TASK_ID,
                event_type: 'REVIEW_RECORDED',
                outcome: 'PASS',
                actor: 'gate',
                message: 'Historical review was recorded for the earlier cycle.',
                details: {
                    review_type: 'code',
                    review_context_path: path.join(reviewsDir, `${TASK_ID}-code-review-context.json`)
                }
            });
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: '2026-01-01T00:00:02.000Z',
                task_id: TASK_ID,
                event_type: 'REVIEW_GATE_PASSED',
                outcome: 'PASS',
                actor: 'gate',
                message: 'Historical review gate passed.'
            });
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: '2026-01-01T00:00:03.000Z',
                task_id: TASK_ID,
                event_type: 'COMPLETION_GATE_PASSED',
                outcome: 'PASS',
                actor: 'gate',
                message: 'Historical completion gate passed.'
            });
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: '2026-01-01T00:00:06.000Z',
                task_id: TASK_ID,
                event_type: 'COMPILE_GATE_PASSED',
                outcome: 'PASS',
                actor: 'gate',
                message: 'A newer compile cycle started after the stale review artifacts were left behind.'
            });

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            assert.equal(result.status, 'INCOMPLETE');
            assert.equal(result.gates.find((gate) => gate.gate === 'required-reviews-check')?.status, 'MISSING');
            assert.equal(result.blockers.find((blocker) => blocker.gate === 'code-review'), undefined);
            assert.equal(result.blockers.find((blocker) => blocker.gate === 'review-coverage'), undefined);

            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: '2026-01-01T00:00:07.000Z',
                task_id: TASK_ID,
                event_type: 'REVIEW_PHASE_STARTED',
                outcome: 'PASS',
                actor: 'gate',
                message: 'The current review phase started.'
            });
            const reviewStartedResult = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });
            assert.equal(reviewStartedResult.status, 'BLOCKED');
            assert.ok(reviewStartedResult.blockers.some((blocker) => blocker.gate === 'review-coverage'));
        });

        it('keeps skipped full-suite evidence non-blocking when the task-bound cycle disabled the mode', () => {
            const now = new Date().toISOString();
            writeWorkflowConfig(tmpDir, false);
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: now,
                task_id: TASK_ID,
                event_type: 'FULL_SUITE_VALIDATION_SKIPPED',
                outcome: 'PASS',
                actor: 'gate',
                message: 'Full-suite validation skipped because the mode is disabled.'
            });
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: new Date(Date.parse(now) + 1000).toISOString(),
                task_id: TASK_ID,
                event_type: 'COMPLETION_GATE_PASSED',
                outcome: 'PASS',
                actor: 'gate',
                message: 'Completion gate passed.'
            });
            writePreflight(reviewsDir, TASK_ID, {
                changed_files: [],
                metrics: { changed_lines_total: 0 },
                required_reviews: {}
            });

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            assert.equal(result.status, 'PASS');
            assert.equal(result.final_report_contract.status, 'READY');
            assert.equal(result.gates.some((gate) => gate.gate === 'full-suite-validation'), false);
            assert.equal(result.blockers.some((blocker) => blocker.gate === 'full-suite-validation'), false);
            assert.equal(result.evidence.some((entry) => entry.kind === 'full-suite-validation' && !entry.exists), false);
            assert.equal(result.evidence.some((entry) => entry.kind === 'completion-gate' && !entry.exists), false);
            assert.equal(result.final_closeout.workflow?.visible_summary_line, 'Mandatory full-suite: false');
            assert.equal(result.final_closeout.workflow?.review_execution_policy_mode, 'code_first_optional');
            assert.equal(result.final_closeout.workflow?.review_execution_policy_summary_line, 'Review execution policy: code_first_optional');
        });

        it('omits zero-diff not-required full-suite and passed completion from absent evidence diagnostics', () => {
            writeWorkflowConfig(tmpDir, true);
            writePassedLifecycle(eventsDir, TASK_ID);
            writePreflight(reviewsDir, TASK_ID, {
                changed_files: [],
                metrics: { changed_lines_total: 0 },
                required_reviews: {},
                scope_category: 'empty',
                zero_diff_guard: {
                    zero_diff_detected: true,
                    status: 'BASELINE_ONLY',
                    completion_requires_audited_no_op: true
                },
                profile_guardrails: {
                    zero_diff_no_reviewable_scope: true
                }
            });

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            assert.equal(result.status, 'PASS');
            assert.equal(result.gates.some((gate) => gate.gate === 'full-suite-validation'), false);
            assert.equal(result.evidence.some((entry) => entry.kind === 'full-suite-validation' && !entry.exists), false);
            assert.equal(result.evidence.some((entry) => entry.kind === 'completion-gate' && !entry.exists), false);
            assert.equal(result.final_closeout.workflow?.visible_summary_line, 'Mandatory full-suite: false');
        });

        it('requires full-suite again when an older skipped event is followed by a newer compile cycle', () => {
            writeWorkflowConfig(tmpDir, true);
            const preflightPath = path.join(reviewsDir, `${TASK_ID}-preflight.json`);
            writePreflight(reviewsDir, TASK_ID, {
                changed_files: ['src/gates/task-audit-summary.ts'],
                metrics: { changed_lines_total: 12 },
                required_reviews: {}
            });
            writeArtifact(reviewsDir, TASK_ID, '-compile-gate.json', {
                timestamp_utc: '2026-01-01T00:00:02.400Z',
                preflight_path: preflightPath,
                preflight_hash_sha256: 'current-cycle'
            });
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: '2026-01-01T00:00:00.000Z',
                task_id: TASK_ID,
                event_type: 'FULL_SUITE_VALIDATION_SKIPPED',
                outcome: 'PASS',
                actor: 'gate',
                message: 'Older cycle skipped full-suite while the mode was disabled.'
            });
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: '2026-01-01T00:00:02.000Z',
                task_id: TASK_ID,
                event_type: 'COMPILE_GATE_PASSED',
                outcome: 'PASS',
                actor: 'gate',
                message: 'A newer compile cycle started after the skipped event.',
                details: {
                    preflight_path: preflightPath.replace(/\\/g, '/'),
                    preflight_hash_sha256: 'current-cycle'
                }
            });

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            assert.equal(result.gates.find((gate) => gate.gate === 'full-suite-validation')?.status, 'MISSING');
            assert.equal(result.final_closeout.workflow?.visible_summary_line, 'Mandatory full-suite: true');
            assert.equal(result.final_closeout.workflow?.review_execution_policy_mode, 'code_first_optional');
        });

        it('keeps legacy compatibility mode for old preflight artifacts even when live config changed later', () => {
            writeWorkflowConfig(tmpDir, false, 'strict_sequential');
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: '2026-01-01T00:00:00.000Z',
                task_id: TASK_ID,
                event_type: 'COMPLETION_GATE_PASSED',
                outcome: 'PASS',
                actor: 'gate',
                message: 'Completion gate passed.'
            });
            writePreflight(reviewsDir, TASK_ID, {
                changed_files: ['src/gates/task-audit-summary.ts'],
                metrics: { changed_lines_total: 12 },
                required_reviews: {},
                review_execution_policy: undefined
            });

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });
            const renderedSummaryText = formatTaskAuditSummaryText(result);
            const renderedMarkdown = formatFinalCloseoutMarkdown(result.final_closeout);

            assert.equal(result.final_closeout.workflow?.review_execution_policy_mode, 'legacy_test_downstream');
            assert.equal(result.final_closeout.workflow?.review_execution_policy_summary_line, 'Review execution policy: legacy_test_downstream (implicit compatibility mode)');
            assert.ok(renderedSummaryText.includes('Review execution policy: legacy_test_downstream (implicit compatibility mode)'));
            assert.ok(renderedMarkdown.includes('Review execution policy: legacy_test_downstream (implicit compatibility mode)'));
            assert.ok(!renderedSummaryText.includes('Review execution policy: strict_sequential'));
            assert.ok(!renderedMarkdown.includes('Review execution policy: strict_sequential'));
        });

        it('surfaces the effective review execution policy in current-cycle audit output', () => {
            writeWorkflowConfig(tmpDir, false, 'strict_sequential');
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: '2026-01-01T00:00:00.000Z',
                task_id: TASK_ID,
                event_type: 'COMPLETION_GATE_PASSED',
                outcome: 'PASS',
                actor: 'gate',
                message: 'Completion gate passed.'
            });
            writePreflight(reviewsDir, TASK_ID, {
                changed_files: ['src/gates/task-audit-summary.ts'],
                metrics: { changed_lines_total: 12 },
                required_reviews: {},
                review_execution_policy: {
                    mode: 'strict_sequential'
                }
            });

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });
            const renderedSummaryText = formatTaskAuditSummaryText(result);
            const renderedMarkdown = formatFinalCloseoutMarkdown(result.final_closeout);

            assert.equal(result.final_closeout.workflow?.review_execution_policy_mode, 'strict_sequential');
            assert.equal(result.final_closeout.workflow?.review_execution_policy_summary_line, 'Review execution policy: strict_sequential');
            assert.ok(renderedSummaryText.includes('Review execution policy: strict_sequential'));
            assert.ok(renderedMarkdown.includes('Review execution policy: strict_sequential'));
        });

        it('recovers the current-cycle review execution policy from timeline evidence when the preflight artifact is gone', () => {
            writeWorkflowConfig(tmpDir, false, 'parallel_all');
            const preflightPath = path.join(reviewsDir, `${TASK_ID}-preflight.json`);
            writePreflight(reviewsDir, TASK_ID, {
                changed_files: ['src/gates/task-audit-summary.ts'],
                metrics: { changed_lines_total: 12 },
                required_reviews: {},
                review_execution_policy: {
                    mode: 'strict_sequential'
                }
            });
            writeArtifact(reviewsDir, TASK_ID, '-compile-gate.json', {
                timestamp_utc: '2026-01-01T00:00:01.000Z',
                preflight_path: preflightPath,
                preflight_hash_sha256: 'cycle-preflight'
            });
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: '2026-01-01T00:00:00.500Z',
                task_id: TASK_ID,
                event_type: 'PREFLIGHT_CLASSIFIED',
                outcome: 'INFO',
                actor: 'gate',
                message: 'Preflight completed with mode FULL_PATH.',
                details: {
                    output_path: preflightPath.replace(/\\/g, '/'),
                    review_execution_policy: {
                        mode: 'strict_sequential'
                    }
                }
            });
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: '2026-01-01T00:00:01.000Z',
                task_id: TASK_ID,
                event_type: 'COMPILE_GATE_PASSED',
                outcome: 'PASS',
                actor: 'gate',
                message: 'Compile gate passed.',
                details: {
                    preflight_path: preflightPath.replace(/\\/g, '/'),
                    preflight_hash_sha256: 'cycle-preflight'
                }
            });
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: '2026-01-01T00:00:02.000Z',
                task_id: TASK_ID,
                event_type: 'COMPLETION_GATE_PASSED',
                outcome: 'PASS',
                actor: 'gate',
                message: 'Completion gate passed.'
            });
            fs.rmSync(preflightPath, { force: true });

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            assert.equal(result.final_closeout.workflow?.review_execution_policy_mode, 'strict_sequential');
            assert.equal(result.final_closeout.workflow?.review_execution_policy_summary_line, 'Review execution policy: strict_sequential');
        });

        it('prefers the latest full-suite terminal event over older skipped evidence from a previous cycle', () => {
            writeWorkflowConfig(tmpDir, false);
            const laterTerminalEvents = [
                { taskId: 'T-201', eventType: 'FULL_SUITE_VALIDATION_PASSED', outcome: 'PASS' },
                { taskId: 'T-202', eventType: 'FULL_SUITE_VALIDATION_WARNED', outcome: 'PASS' },
                { taskId: 'T-203', eventType: 'FULL_SUITE_VALIDATION_FAILED', outcome: 'FAIL' }
            ] as const;

            for (const [index, laterTerminalEvent] of laterTerminalEvents.entries()) {
                const now = Date.parse('2026-01-01T00:00:00.000Z') + (index * 1000);
                writeEvent(eventsDir, laterTerminalEvent.taskId, {
                    timestamp_utc: new Date(now).toISOString(),
                    task_id: laterTerminalEvent.taskId,
                    event_type: 'FULL_SUITE_VALIDATION_SKIPPED',
                    outcome: 'PASS',
                    actor: 'gate',
                    message: 'Full-suite validation skipped because the mode is disabled.'
                });
                writeEvent(eventsDir, laterTerminalEvent.taskId, {
                    timestamp_utc: new Date(now + 1).toISOString(),
                    task_id: laterTerminalEvent.taskId,
                    event_type: laterTerminalEvent.eventType,
                    outcome: laterTerminalEvent.outcome,
                    actor: 'gate',
                    message: `Later cycle emitted ${laterTerminalEvent.eventType}.`
                });
                writePreflight(reviewsDir, laterTerminalEvent.taskId, {
                    changed_files: [],
                    metrics: { changed_lines_total: 0 },
                    required_reviews: {}
                });

                const result = buildTaskAuditSummary({
                    taskId: laterTerminalEvent.taskId,
                    repoRoot: tmpDir,
                    eventsRoot: eventsDir,
                    reviewsRoot: reviewsDir
                });

                assert.equal(result.final_closeout.workflow?.visible_summary_line, 'Mandatory full-suite: true');
                assert.equal(result.gates.some((gate) => gate.gate === 'full-suite-validation'), true);
            }
        });

        it('keeps current-cycle full-suite gate evidence when the compile artifact timestamp trails the compile event', () => {
            writeWorkflowConfig(tmpDir, true);
            const preflightPath = path.join(reviewsDir, `${TASK_ID}-preflight.json`);
            writePreflight(reviewsDir, TASK_ID, {
                changed_files: ['src/gates/task-audit-summary.ts'],
                metrics: { changed_lines_total: 12 },
                required_reviews: {}
            });
            writeArtifact(reviewsDir, TASK_ID, '-compile-gate.json', {
                timestamp_utc: '2026-01-01T00:00:00.400Z',
                preflight_path: preflightPath,
                preflight_hash_sha256: 'current-cycle'
            });
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: '2026-01-01T00:00:00.000Z',
                task_id: TASK_ID,
                event_type: 'COMPILE_GATE_PASSED',
                outcome: 'PASS',
                actor: 'gate',
                message: 'Compile gate passed for the current cycle.',
                details: {
                    preflight_path: preflightPath.replace(/\\/g, '/'),
                    preflight_hash_sha256: 'current-cycle'
                }
            });
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: '2026-01-01T00:00:02.000Z',
                task_id: TASK_ID,
                event_type: 'FULL_SUITE_VALIDATION_PASSED',
                outcome: 'PASS',
                actor: 'gate',
                message: 'Full-suite validation passed for the current cycle.',
                details: {
                    cycle_binding: {
                        preflight_path: preflightPath.replace(/\\/g, '/'),
                        preflight_sha256: 'current-cycle',
                        compile_gate_timestamp: '2026-01-01T00:00:00.000Z'
                    }
                }
            });

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            assert.equal(result.gates.find((gate) => gate.gate === 'compile-gate')?.status, 'PASS');
            assert.equal(result.gates.find((gate) => gate.gate === 'full-suite-validation')?.status, 'PASS');
        });

        it('keeps older full-suite gate evidence when closeout recovery has unchanged scope binding', () => {
            writeWorkflowConfig(tmpDir, true);
            const preflightPath = path.join(reviewsDir, `${TASK_ID}-preflight.json`);
            const changedFilesSha = '1'.repeat(64);
            const scopeSha = '2'.repeat(64);
            const scopeContentSha = '3'.repeat(64);
            writePreflight(reviewsDir, TASK_ID, {
                changed_files: ['src/gates/task-audit-summary.ts'],
                metrics: {
                    changed_lines_total: 12,
                    changed_files_sha256: changedFilesSha,
                    scope_sha256: scopeSha,
                    scope_content_sha256: scopeContentSha
                },
                required_reviews: {}
            });
            writeArtifact(reviewsDir, TASK_ID, '-compile-gate.json', {
                timestamp_utc: '2026-01-01T10:00:00.000Z',
                preflight_path: preflightPath,
                preflight_hash_sha256: 'new-cycle',
                preflight_changed_files_sha256: changedFilesSha,
                preflight_scope_sha256: scopeSha,
                preflight_scope_content_sha256: scopeContentSha
            });
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: '2026-01-01T09:45:00.000Z',
                task_id: TASK_ID,
                event_type: 'FULL_SUITE_VALIDATION_PASSED',
                outcome: 'PASS',
                actor: 'gate',
                message: 'Full-suite validation passed before no-change closeout recovery.',
                details: {
                    cycle_binding: {
                        preflight_path: preflightPath.replace(/\\/g, '/'),
                        preflight_sha256: 'old-cycle',
                        compile_gate_timestamp: '2026-01-01T09:30:00.000Z',
                        scope_binding: {
                            changed_files_sha256: changedFilesSha,
                            scope_sha256: scopeSha,
                            scope_content_sha256: scopeContentSha
                        }
                    }
                }
            });
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: '2026-01-01T10:00:00.000Z',
                task_id: TASK_ID,
                event_type: 'COMPILE_GATE_PASSED',
                outcome: 'PASS',
                actor: 'gate',
                message: 'Compile gate passed during closeout recovery.',
                details: {
                    preflight_path: preflightPath.replace(/\\/g, '/'),
                    preflight_hash_sha256: 'new-cycle',
                    preflight_changed_files_sha256: changedFilesSha,
                    preflight_scope_sha256: scopeSha,
                    preflight_scope_content_sha256: scopeContentSha
                }
            });

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            assert.equal(result.gates.find((gate) => gate.gate === 'compile-gate')?.status, 'PASS');
            assert.equal(result.gates.find((gate) => gate.gate === 'full-suite-validation')?.status, 'PASS');
        });
    });
});
