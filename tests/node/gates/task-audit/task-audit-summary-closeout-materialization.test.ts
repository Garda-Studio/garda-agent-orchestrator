import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
    fs,
    path,
    buildTaskAuditSummary,
    formatTaskAuditSummaryText,
    formatFinalCloseoutMarkdown,
    synchronizeFinalCloseoutArtifacts,
    writeEvent,
    writePreflight,
    writeArtifact,
    writeWorkflowConfig,
    makeTempDir} from './task-audit-summary-fixtures';


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

        it('writes canonical final closeout json and markdown artifacts for PASS summaries', () => {
            const now = new Date().toISOString();
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: new Date(Date.parse(now) - 7000).toISOString(),
                task_id: TASK_ID,
                event_type: 'TASK_MODE_ENTERED',
                outcome: 'PASS',
                actor: 'gate',
                message: 'Task mode entered.'
            });
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: new Date(Date.parse(now) - 6000).toISOString(),
                task_id: TASK_ID,
                event_type: 'RULE_PACK_LOADED',
                outcome: 'PASS',
                actor: 'gate',
                message: 'Rule pack loaded.'
            });
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: new Date(Date.parse(now) - 5000).toISOString(),
                task_id: TASK_ID,
                event_type: 'HANDSHAKE_DIAGNOSTICS_RECORDED',
                outcome: 'PASS',
                actor: 'gate',
                message: 'Handshake diagnostics recorded.'
            });
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: new Date(Date.parse(now) - 4000).toISOString(),
                task_id: TASK_ID,
                event_type: 'SHELL_SMOKE_PREFLIGHT_RECORDED',
                outcome: 'PASS',
                actor: 'gate',
                message: 'Shell smoke recorded.'
            });
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: new Date(Date.parse(now) - 3000).toISOString(),
                task_id: TASK_ID,
                event_type: 'PREFLIGHT_CLASSIFIED',
                outcome: 'PASS',
                actor: 'gate',
                message: 'Preflight classified.'
            });
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: new Date(Date.parse(now) - 2000).toISOString(),
                task_id: TASK_ID,
                event_type: 'COMPILE_GATE_PASSED',
                outcome: 'PASS',
                actor: 'gate',
                message: 'Compile gate passed.'
            });
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: new Date(Date.parse(now) - 1000).toISOString(),
                task_id: TASK_ID,
                event_type: 'REVIEW_GATE_PASSED',
                outcome: 'PASS',
                actor: 'gate',
                message: 'Review gate passed.'
            });
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: new Date(Date.parse(now) - 500).toISOString(),
                task_id: TASK_ID,
                event_type: 'DOC_IMPACT_ASSESSED',
                outcome: 'PASS',
                actor: 'gate',
                message: 'Doc impact assessed.'
            });
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: now,
                task_id: TASK_ID,
                event_type: 'COMPLETION_GATE_PASSED',
                outcome: 'PASS',
                actor: 'gate',
                message: 'Completion gate passed.'
            });
            writeArtifact(reviewsDir, TASK_ID, '-task-mode.json', {
                requested_depth: 2,
                effective_depth: 2
            });
            writePreflight(reviewsDir, TASK_ID, {
                mode: 'FULL_PATH',
                changed_files: ['src/example.ts'],
                metrics: { changed_lines_total: 12 },
                required_reviews: {}
            });
            const scratchLaunchPath = path.join(
                tmpDir,
                'garda-agent-orchestrator',
                'runtime',
                'tmp',
                'reviews',
                TASK_ID,
                'code',
                'reviewer-launch.json'
            );
            fs.mkdirSync(path.dirname(scratchLaunchPath), { recursive: true });
            fs.writeFileSync(scratchLaunchPath, '{}\n', 'utf8');

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });
            result.final_closeout.commit_command_suggestion = 'git commit -m "ACCESS_TOKEN=closeout-secret-value"';

            synchronizeFinalCloseoutArtifacts(result);

            const jsonPath = path.join(reviewsDir, `${TASK_ID}-final-closeout.json`);
            const markdownPath = path.join(reviewsDir, `${TASK_ID}-final-closeout.md`);
            const renderedMarkdown = formatFinalCloseoutMarkdown(result.final_closeout);
            const renderedSummaryText = formatTaskAuditSummaryText(result);
            assert.equal(fs.existsSync(jsonPath), true);
            assert.equal(fs.existsSync(markdownPath), true);
            assert.equal(fs.existsSync(scratchLaunchPath), false);
            assert.equal(fs.existsSync(path.join(tmpDir, 'garda-agent-orchestrator', 'runtime', 'tmp', 'reviews', TASK_ID)), false);
            assert.equal(result.final_closeout.artifact_state, 'MATERIALIZED');
            assert.equal(result.evidence.find((entry) => entry.kind === 'final-closeout-json')?.exists, true);
            const closeoutJson = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
            const closeoutJsonText = fs.readFileSync(jsonPath, 'utf8');
            const closeoutMarkdownText = fs.readFileSync(markdownPath, 'utf8');
            assert.equal(closeoutJson.artifact_state, 'MATERIALIZED');
            assert.ok(!closeoutJsonText.includes('closeout-secret-value'));
            assert.ok(!closeoutMarkdownText.includes('closeout-secret-value'));
            assert.ok(closeoutJsonText.includes('ACCESS_TOKEN=<redacted>'));
            assert.ok(closeoutMarkdownText.includes('ACCESS_TOKEN=<redacted>'));
            assert.equal(closeoutJson.workflow.visible_summary_line, 'Mandatory full-suite: false');
            assert.equal(closeoutJson.task_queue_status_contract.authority, 'gate_owned_status_sync');
            assert.deepEqual(closeoutJson.task_queue_status_contract.agent_blocked_statuses, ['IN_PROGRESS', 'IN_REVIEW', 'DONE', 'BLOCKED', 'SPLIT_REQUIRED']);
            assert.ok(fs.readFileSync(markdownPath, 'utf8').includes('Suggested commit command:'));
            assert.ok(fs.readFileSync(markdownPath, 'utf8').includes('Mandatory full-suite: false'));
            assert.ok(fs.readFileSync(markdownPath, 'utf8').includes('Task status sync: gate-owned for IN_PROGRESS/IN_REVIEW/SPLIT_REQUIRED/DONE'));
            assert.ok(renderedSummaryText.includes('Mandatory full-suite: false'));
            assert.ok(renderedSummaryText.includes('Task status sync: gate-owned for IN_PROGRESS/IN_REVIEW/SPLIT_REQUIRED/DONE'));
            const confirmationQuestion = 'Do you want me to commit now? (yes/no)';
            assert.equal(result.final_closeout.commit_question, confirmationQuestion);
            assert.ok(renderedMarkdown.includes(confirmationQuestion));
            assert.ok(renderedMarkdown.includes('Do you want me to commit now? (yes/no)'));
            assert.ok(renderedMarkdown.includes('Task status sync: gate-owned for IN_PROGRESS/IN_REVIEW/SPLIT_REQUIRED/DONE'));
        });

        it('renders the mandatory full-suite summary line when present', () => {
            const renderedMarkdown = formatFinalCloseoutMarkdown({
                schema_version: 1,
                event_source: 'task-audit-summary',
                task_id: TASK_ID,
                generated_utc: '2026-01-01T00:00:00.000Z',
                audit_status: 'PASS',
                status: 'READY',
                blocker: null,
                artifact_state: 'MATERIALIZED',
                artifact_paths: {
                    json: 'runtime/reviews/T-149-final-closeout.json',
                    markdown: 'runtime/reviews/T-149-final-closeout.md'
                },
                implementation_summary: {
                    requested_depth: 2,
                    effective_depth: 2,
                    path_mode: 'FULL_PATH',
                    review_verdicts: { code: 'REVIEW PASSED' },
                    docs_updated: false,
                    changed_files_count: 1,
                    changed_lines_total: 5,
                    scope_category: 'code',
                    active_profile: 'balanced'
                },
                review_trust: {
                    status: 'ASSERTED_LOCAL_ONLY',
                    trust_levels: ['LOCAL_ASSERTED'],
                    execution_modes: ['DELEGATED_SUBAGENT'],
                    independent_review_attested: false,
                    reused_count: 0,
                    fresh_count: 1,
                    completion_policy: 'ASSERTED_LOCAL_BLOCKED',
                    visible_summary_line: 'Review trust: LOCAL_ASSERTED via DELEGATED_SUBAGENT; not independent audited review.',
                    policy_summary_line: 'Review policy: asserted local review cannot satisfy mandatory independent review for this code task; use independent reviewer launch attestation or human sign-off.'
                },
                workflow: {
                    mandatory_full_suite_enabled: true,
                    visible_summary_line: 'Mandatory full-suite: true'
                },
                docs: {
                    decision: 'NO_DOC_UPDATES',
                    behavior_changed: false,
                    changelog_updated: false,
                    docs_updated: []
                },
                token_economy: null,
                commit_command_template: 'git commit -m "<type>(<scope>): <summary>"',
                commit_command_suggestion: 'git commit -m "feat(workflow): full-suite toggle"',
                commit_question: 'Do you want me to commit now? (yes/no)'
            });

            assert.ok(renderedMarkdown.includes('Mandatory full-suite: true'));
            assert.ok(renderedMarkdown.includes('Review trust: LOCAL_ASSERTED via DELEGATED_SUBAGENT; not independent audited review.'));
            assert.ok(renderedMarkdown.includes('Review policy: asserted local review cannot satisfy mandatory independent review for this code task; use independent reviewer launch attestation or human sign-off.'));
        });

        it('removes stale final closeout artifacts when the audit summary is not ready', () => {
            const jsonPath = path.join(reviewsDir, `${TASK_ID}-final-closeout.json`);
            const markdownPath = path.join(reviewsDir, `${TASK_ID}-final-closeout.md`);
            fs.writeFileSync(jsonPath, '{}\n', 'utf8');
            fs.writeFileSync(markdownPath, 'stale\n', 'utf8');
            fs.writeFileSync(path.join(eventsDir, `${TASK_ID}.jsonl`), '', 'utf8');
            writePreflight(reviewsDir, TASK_ID, {
                mode: 'FULL_PATH',
                changed_files: ['src/example.ts'],
                metrics: { changed_lines_total: 12 },
                required_reviews: {}
            });

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            synchronizeFinalCloseoutArtifacts(result);

            assert.equal(fs.existsSync(jsonPath), false);
            assert.equal(fs.existsSync(markdownPath), false);
            assert.equal(result.final_closeout.artifact_state, 'REMOVED');
            assert.equal(result.evidence.find((entry) => entry.kind === 'final-closeout-json')?.exists, false);
        });

        it('preserves existing final closeout artifacts when an in-flight snapshot becomes stale before sync', () => {
            const jsonPath = path.join(reviewsDir, `${TASK_ID}-final-closeout.json`);
            const markdownPath = path.join(reviewsDir, `${TASK_ID}-final-closeout.md`);
            fs.writeFileSync(jsonPath, '{}\n', 'utf8');
            fs.writeFileSync(markdownPath, 'ready\n', 'utf8');

            const summary = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });
            summary.point_in_time_snapshot = {
                status: 'FINALIZATION_IN_FLIGHT',
                gate: 'completion-gate',
                message: 'Completion gate is currently in flight.',
                recommended_action: 'Re-run task-audit-summary sequentially after completion-gate finishes.',
                lock_path: path.join(reviewsDir, `${TASK_ID}-completion-gate.lock`).replace(/\\/g, '/')
            };
            summary.final_closeout = {
                ...summary.final_closeout,
                status: 'NOT_READY',
                artifact_state: 'NOT_READY'
            };

            synchronizeFinalCloseoutArtifacts(summary);

            assert.equal(fs.existsSync(jsonPath), true);
            assert.equal(fs.existsSync(markdownPath), true);
            assert.equal(summary.final_closeout.artifact_state, 'MATERIALIZED');
            assert.equal(summary.evidence.find((entry) => entry.kind === 'final-closeout-json')?.exists, true);
        });
    });

    describe('commit guidance based on worktree state', () => {

    });
});
