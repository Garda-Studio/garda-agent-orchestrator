import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
    fs,
    path,
    execFileSync,
    buildTaskAuditSummary,
    formatFinalCloseoutMarkdown,
    writeEvent,
    writePreflight,
    writeWorkflowConfig,
    initGitRepo,
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

        it('infers a conventional-style commit suggestion from task metadata and changed scope', () => {
            const now = new Date().toISOString();
            fs.writeFileSync(path.join(tmpDir, 'TASK.md'), [
                '# TASK.md',
                '',
                '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
                '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
                '| T-AUDIT-1 | 🟩 DONE | P2 | ux/conventional-commit-suggestion | Make the final agent report suggest conventional-style commit messages by default | gpt-5.4 | 2026-04-15 | balanced | |'
            ].join('\n'), 'utf8');
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: now,
                task_id: TASK_ID,
                event_type: 'COMPLETION_GATE_PASSED',
                outcome: 'PASS',
                actor: 'gate',
                message: 'Completion gate passed.'
            });
            writePreflight(reviewsDir, TASK_ID, {
                changed_files: [
                    'src/gates/task-audit-summary.ts',
                    'template/docs/agent-rules/80-task-workflow.md'
                ],
                metrics: { changed_lines_total: 42 },
                required_reviews: {}
            });

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            assert.equal(result.final_report_contract.commit_command_template, 'git commit -m "<type>(<scope>): <summary>"');
            assert.equal(result.final_report_contract.commit_command_suggestion, 'git commit -m "fix(orchestration): conventional commit suggestion"');
            assert.deepEqual(result.final_report_contract.required_order, [
                'short agent-authored summary of what changed',
                'verbatim Garda final user report'
            ]);
        });

        it('uses a materialized grouped review follow-up title instead of repeating the parent area subject', () => {
            const now = new Date().toISOString();
            const fingerprint = 'a'.repeat(64);
            fs.writeFileSync(path.join(tmpDir, 'TASK.md'), [
                '# TASK.md',
                '',
                '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
                '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
                `| T-AUDIT-1 | 🟩 DONE | P2 | architecture/next-step-transition-table | Address grouped deferred review findings and residual risks | codex | 2026-09-20 | balanced | Child of \`T-028\`. review_follow_up_group_fingerprint=${fingerprint}. |`
            ].join('\n'), 'utf8');
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: now,
                task_id: TASK_ID,
                event_type: 'COMPLETION_GATE_PASSED',
                outcome: 'PASS',
                actor: 'gate',
                message: 'Completion gate passed.'
            });
            writePreflight(reviewsDir, TASK_ID, {
                changed_files: ['src/gates/next-step/next-step.ts'],
                metrics: { changed_lines_total: 12 },
                required_reviews: {}
            });

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            assert.equal(
                result.final_report_contract.commit_command_suggestion,
                'git commit -m "fix(orchestration): address grouped deferred review findings and residual risks"'
            );
        });

        it('uses a materialized per-finding review follow-up title instead of repeating the parent area subject', () => {
            const now = new Date().toISOString();
            const fingerprint = 'b'.repeat(64);
            fs.writeFileSync(path.join(tmpDir, 'TASK.md'), [
                '# TASK.md',
                '',
                '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
                '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
                `| T-AUDIT-1 | 🟩 DONE | P2 | architecture/next-step-transition-table | Address deferred review finding F-001 | codex | 2026-09-20 | balanced | Child of \`T-028\`. review_follow_up_fingerprint=${fingerprint}. |`
            ].join('\n'), 'utf8');
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: now,
                task_id: TASK_ID,
                event_type: 'COMPLETION_GATE_PASSED',
                outcome: 'PASS',
                actor: 'gate',
                message: 'Completion gate passed.'
            });
            writePreflight(reviewsDir, TASK_ID, {
                changed_files: ['src/gates/next-step/next-step.ts'],
                metrics: { changed_lines_total: 12 },
                required_reviews: {}
            });

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            assert.equal(
                result.final_report_contract.commit_command_suggestion,
                'git commit -m "fix(orchestration): address deferred review finding F 001"'
            );
        });

        it('preserves area-first commit guidance for a malformed review follow-up marker', () => {
            const now = new Date().toISOString();
            fs.writeFileSync(path.join(tmpDir, 'TASK.md'), [
                '# TASK.md',
                '',
                '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
                '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
                '| T-AUDIT-1 | 🟩 DONE | P2 | architecture/next-step-transition-table | Ordinary task title | codex | 2026-09-20 | balanced | review_follow_up_group_fingerprint=abc123. |'
            ].join('\n'), 'utf8');
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: now,
                task_id: TASK_ID,
                event_type: 'COMPLETION_GATE_PASSED',
                outcome: 'PASS',
                actor: 'gate',
                message: 'Completion gate passed.'
            });
            writePreflight(reviewsDir, TASK_ID, {
                changed_files: ['src/gates/next-step/next-step.ts'],
                metrics: { changed_lines_total: 12 },
                required_reviews: {}
            });

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            assert.equal(
                result.final_report_contract.commit_command_suggestion,
                'git commit -m "fix(orchestration): next step transition table"'
            );
        });

        it('initializes git fixtures without inheriting global commit signing or hooks', () => {
            const hooksDir = path.join(tmpDir, 'global-hooks');
            fs.mkdirSync(hooksDir, { recursive: true });
            fs.writeFileSync(path.join(hooksDir, 'pre-commit'), '#!/bin/sh\nexit 42\n', { encoding: 'utf8', mode: 0o755 });
            const globalConfigPath = path.join(tmpDir, 'global-gitconfig');
            fs.writeFileSync(globalConfigPath, [
                '[commit]',
                '    gpgsign = true',
                '[core]',
                `    hooksPath = ${hooksDir.replace(/\\/g, '/')}`,
                ''
            ].join('\n'), 'utf8');

            const previousGlobalConfigPath = process.env.GIT_CONFIG_GLOBAL;
            process.env.GIT_CONFIG_GLOBAL = globalConfigPath;
            try {
                initGitRepo(tmpDir);
            } finally {
                if (previousGlobalConfigPath === undefined) {
                    delete process.env.GIT_CONFIG_GLOBAL;
                } else {
                    process.env.GIT_CONFIG_GLOBAL = previousGlobalConfigPath;
                }
            }

            const latestSubject = execFileSync('git', ['log', '--format=%s', '-1'], { cwd: tmpDir, encoding: 'utf8' }).trim();
            const status = execFileSync('git', ['status', '--short'], { cwd: tmpDir, encoding: 'utf8' }).trim();
            assert.equal(latestSubject, 'baseline');
            assert.equal(status, '');
        });

        it('keeps commit guidance when tracked worktree changes are still committable', () => {
            const sourceFile = path.join(tmpDir, 'src', 'gates', 'task-audit-summary.ts');
            fs.mkdirSync(path.dirname(sourceFile), { recursive: true });
            fs.writeFileSync(sourceFile, 'export const before = true;\n', 'utf8');
            fs.writeFileSync(path.join(tmpDir, 'TASK.md'), [
                '# TASK.md',
                '',
                '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
                '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
                '| T-AUDIT-1 | 🟩 DONE | P2 | ux/final-chat-commit-guidance-regression | Enforce final chat commit guidance | gpt-5.4 | 2026-04-15 | balanced | |'
            ].join('\n'), 'utf8');
            initGitRepo(tmpDir);
            fs.writeFileSync(sourceFile, 'export const after = true;\n', 'utf8');
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
                changed_files: ['src/gates/task-audit-summary.ts'],
                metrics: { changed_lines_total: 8 },
                required_reviews: {}
            });

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            assert.match(result.final_report_contract.commit_command_suggestion, /^git commit -m "/);
            assert.equal(result.final_report_contract.commit_question, 'Do you want me to commit now? (yes/no)');
            assert.deepEqual(result.final_report_contract.required_order, [
                'short agent-authored summary of what changed',
                'verbatim Garda final user report'
            ]);
        });

        it('keeps commit guidance when untracked source files are still committable', () => {
            initGitRepo(tmpDir);
            const untrackedTestFile = path.join(tmpDir, 'tests', 'node', 'gates', 'new-task.test.ts');
            fs.mkdirSync(path.dirname(untrackedTestFile), { recursive: true });
            fs.writeFileSync(untrackedTestFile, 'test("new task", () => {});\n', 'utf8');
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
                changed_files: ['tests/node/gates/new-task.test.ts'],
                metrics: { changed_lines_total: 1 },
                required_reviews: {}
            });

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            assert.match(result.final_report_contract.commit_command_suggestion, /^git commit -m "/);
            assert.equal(result.final_report_contract.commit_question, 'Do you want me to commit now? (yes/no)');
            assert.deepEqual(result.final_report_contract.required_order, [
                'short agent-authored summary of what changed',
                'verbatim Garda final user report'
            ]);
        });

        it('builds commit guidance from task-owned dirty-baseline scope instead of untouched baseline files', () => {
            fs.writeFileSync(path.join(tmpDir, 'TASK.md'), [
                '# TASK.md',
                '',
                '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
                '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
                '| T-AUDIT-1 | 🟩 DONE | P1 | workflow/dirty-baseline-recovery-commit-scope | Keep restart recovery compile remediation and commit scope bound to current task-owned files | gpt-5.4 | 2026-07-13 | balanced | |'
            ].join('\n'), 'utf8');
            const taskOwnedFile = path.join(tmpDir, 'src', 'gates', 'review-context', 'task-owned.ts');
            const untouchedRuntimeOne = path.join(tmpDir, 'src', 'gate-runtime', 'local-one.ts');
            const untouchedRuntimeTwo = path.join(tmpDir, 'src', 'gate-runtime', 'local-two.ts');
            for (const filePath of [taskOwnedFile, untouchedRuntimeOne, untouchedRuntimeTwo]) {
                fs.mkdirSync(path.dirname(filePath), { recursive: true });
                fs.writeFileSync(filePath, 'export const value = "before";\n', 'utf8');
            }
            initGitRepo(tmpDir);
            fs.writeFileSync(taskOwnedFile, 'export const value = "task-owned";\n', 'utf8');
            fs.writeFileSync(untouchedRuntimeOne, 'export const value = "local one";\n', 'utf8');
            fs.writeFileSync(untouchedRuntimeTwo, 'export const value = "local two";\n', 'utf8');
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
                changed_files: [
                    'src/gates/review-context/task-owned.ts',
                    'src/gate-runtime/local-one.ts',
                    'src/gate-runtime/local-two.ts'
                ],
                triggers: {
                    dirty_workspace_task_owned_files: ['src/gates/review-context/task-owned.ts'],
                    dirty_workspace_untouched_baseline_files: [
                        'src/gate-runtime/local-one.ts',
                        'src/gate-runtime/local-two.ts'
                    ]
                },
                metrics: { changed_lines_total: 9 },
                required_reviews: {}
            });

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            assert.equal(
                result.final_report_contract.commit_command_suggestion,
                'git commit -m "fix(orchestration): dirty baseline recovery commit scope"'
            );
        });

        it('suppresses commit suggestions when dirty-baseline filtering excludes every committable file', () => {
            fs.writeFileSync(path.join(tmpDir, 'TASK.md'), [
                '# TASK.md',
                '',
                '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
                '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
                '| T-AUDIT-1 | 🟩 DONE | P1 | workflow/dirty-baseline-recovery-commit-scope | Keep restart recovery compile remediation and commit scope bound to current task-owned files | gpt-5.4 | 2026-07-13 | balanced | |'
            ].join('\n'), 'utf8');
            const untouchedRuntimeOne = path.join(tmpDir, 'src', 'gate-runtime', 'local-one.ts');
            const untouchedRuntimeTwo = path.join(tmpDir, 'src', 'gate-runtime', 'local-two.ts');
            for (const filePath of [untouchedRuntimeOne, untouchedRuntimeTwo]) {
                fs.mkdirSync(path.dirname(filePath), { recursive: true });
                fs.writeFileSync(filePath, 'export const value = "before";\n', 'utf8');
            }
            initGitRepo(tmpDir);
            fs.writeFileSync(untouchedRuntimeOne, 'export const value = "local one";\n', 'utf8');
            fs.writeFileSync(untouchedRuntimeTwo, 'export const value = "local two";\n', 'utf8');
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
                changed_files: [
                    'src/gate-runtime/local-one.ts',
                    'src/gate-runtime/local-two.ts'
                ],
                triggers: {
                    dirty_workspace_task_owned_files: [],
                    dirty_workspace_untouched_baseline_files: [
                        'src/gate-runtime/local-one.ts',
                        'src/gate-runtime/local-two.ts'
                    ]
                },
                metrics: { changed_lines_total: 6 },
                required_reviews: {}
            });

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });
            const renderedMarkdown = formatFinalCloseoutMarkdown(result.final_closeout);

            assert.equal(result.final_report_contract.commit_command_template, 'No commit command required.');
            assert.equal(
                result.final_report_contract.commit_command_suggestion,
                'No commit required: no committable changes are present.'
            );
            assert.equal(result.final_report_contract.commit_question, 'No commit confirmation required.');
            assert.ok(!renderedMarkdown.includes('git commit -m "'));
            assert.ok(renderedMarkdown.includes('No commit required: no committable changes are present.'));
        });

        it('suppresses commit suggestions when the tracked worktree is already clean', () => {
            const sourceFile = path.join(tmpDir, 'src', 'gates', 'task-audit-summary.ts');
            fs.mkdirSync(path.dirname(sourceFile), { recursive: true });
            fs.writeFileSync(sourceFile, 'export const clean = true;\n', 'utf8');
            initGitRepo(tmpDir);
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
                changed_files: ['src/gates/task-audit-summary.ts'],
                metrics: { changed_lines_total: 8 },
                required_reviews: {}
            });

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });
            const renderedMarkdown = formatFinalCloseoutMarkdown(result.final_closeout);

            assert.equal(result.final_report_contract.commit_command_template, 'No commit command required.');
            assert.equal(result.final_report_contract.commit_command_suggestion, 'No commit required: no committable changes are present.');
            assert.equal(result.final_report_contract.commit_question, 'No commit confirmation required.');
            assert.deepEqual(result.final_report_contract.required_order, [
                'short agent-authored summary of what changed',
                'verbatim Garda final user report'
            ]);
            assert.ok(!renderedMarkdown.includes('git commit -m "'));
            assert.ok(renderedMarkdown.includes('Commit guidance:'));
            assert.ok(renderedMarkdown.includes('No commit required: no committable changes are present.'));
        });

        it('suppresses commit suggestions when only ignored runtime control-plane files changed', () => {
            initGitRepo(tmpDir);
            fs.writeFileSync(path.join(reviewsDir, 'local-only.md'), 'ignored local artifact\n', 'utf8');
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
                changed_files: ['garda-agent-orchestrator/runtime/reviews/local-only.md'],
                metrics: { changed_lines_total: 1 },
                required_reviews: {}
            });

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            assert.equal(result.final_report_contract.commit_command_suggestion, 'No commit required: no committable changes are present.');
            assert.deepEqual(result.final_report_contract.required_order, [
                'short agent-authored summary of what changed',
                'verbatim Garda final user report'
            ]);
            assert.ok(!result.final_report_contract.required_order.join('\n').includes('git commit -m "'));
            assert.ok(!result.final_report_contract.required_order.join('\n').includes('Do you want me to commit now?'));
        });
    });

    describe('final closeout materialization', () => {
        it('suppresses commit command and question when the worktree is already clean', () => {
            // Setup a clean git repo in tmpDir
            const execSync = require('node:child_process').execSync;
            execSync('git init', { cwd: tmpDir, stdio: 'ignore' });
            const configPath = path.join(tmpDir, '.git', 'config');
            if (fs.existsSync(configPath)) {
                const userConfig = '\n[commit]\n\tgpgsign = false\n[tag]\n\tgpgsign = false\n[user]\n\tname = Test\n\temail = test@example.com\n';
                fs.appendFileSync(configPath, userConfig, 'utf8');
            }
            execSync('git commit --allow-empty -m "Initial commit"', { cwd: tmpDir, stdio: 'ignore' });

            writePreflight(reviewsDir, TASK_ID, {
                changed_files: ['docs/landing.md'],
                metrics: { changed_lines_total: 10 },
                required_reviews: {}
            });
            fs.writeFileSync(path.join(eventsDir, `${TASK_ID}.jsonl`), '', 'utf8');

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            assert.equal(
                result.final_closeout.commit_question,
                'No commit confirmation required.'
            );
            assert.equal(
                result.final_report_contract.commit_question,
                'No commit confirmation required.'
            );
            assert.equal(
                result.final_report_contract.commit_command_suggestion,
                'No commit required: no committable changes are present.'
            );
            assert.deepEqual(result.final_report_contract.required_order, [
                'short agent-authored summary of what changed',
                'verbatim Garda final user report'
            ]);
            assert.ok(!result.final_report_contract.required_order.join('\n').includes('git commit -m "'));
            assert.ok(!result.final_report_contract.required_order.join('\n').includes('Do you want me to commit now?'));
        });
    });

    describe('formatTaskAuditSummaryText', () => {

    });
});
