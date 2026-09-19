import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import {
    type WhyBlockedResult,
    getWhyBlocked,
    formatWhyBlockedResult
} from '../../../src/validators/why-blocked';

// ── Helper ────────────────────────────────────────────────────────────────────

function makeTaskMd(rows: string[]): string {
    const header = '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |';
    const sep    = '|---|---|---|---|---|---|---|---|---|';
    return `<!-- garda-agent-orchestrator:managed-start -->\n# TASK.md\n\n## Active Queue\n${header}\n${sep}\n${rows.join('\n')}\n<!-- garda-agent-orchestrator:managed-end -->\n`;
}

// ── getWhyBlocked ─────────────────────────────────────────────────────────────

test('getWhyBlocked returns no blocked tasks when TASK.md is absent', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'why-blocked-test-'));
    try {
        const result = getWhyBlocked(tmpDir);
        assert.equal(result.has_blocked_tasks, false);
        assert.deepEqual(result.blocked_tasks, []);
        assert.deepEqual(result.lock_observations, []);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('getWhyBlocked returns no blocked tasks when all tasks are DONE', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'why-blocked-test-'));
    try {
        fs.writeFileSync(
            path.join(tmpDir, 'TASK.md'),
            makeTaskMd(['| T-001 | 🟩 DONE | P0 | area | Title | me | 2026-01-01 | default | Notes |']),
            'utf8'
        );

        const result = getWhyBlocked(tmpDir);
        assert.equal(result.has_blocked_tasks, false);
        assert.deepEqual(result.blocked_tasks, []);
        assert.deepEqual(result.lock_observations, []);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('getWhyBlocked ignores lower human summary tables that repeat task-looking rows', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'why-blocked-test-'));
    try {
        fs.writeFileSync(
            path.join(tmpDir, 'TASK.md'),
            [
                makeTaskMd(['| T-001 | 🟩 DONE | P0 | area | Title | me | 2026-01-01 | default | Notes |']).trimEnd(),
                '',
                '## User Summary (RU)',
                '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
                '|---|---|---|---|---|---|---|---|---|',
                '| T-999 | 🟥 BLOCKED | P1 | lower | Lower-only task | me | 2026-01-01 | default | blocked_reason_code=LOWER_BLOCK |',
                ''
            ].join('\n'),
            'utf8'
        );

        const result = getWhyBlocked(tmpDir);
        assert.equal(result.has_blocked_tasks, false);
        assert.deepEqual(result.blocked_tasks, []);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('getWhyBlocked detects BLOCKED task', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'why-blocked-test-'));
    try {
        fs.writeFileSync(
            path.join(tmpDir, 'TASK.md'),
            makeTaskMd(['| T-002 | 🟥 BLOCKED | P1 | area | Blocked task | me | 2026-01-01 | default | blocked_reason_code=EXTERNAL_DEPENDENCY |']),
            'utf8'
        );

        const result = getWhyBlocked(tmpDir);
        assert.equal(result.has_blocked_tasks, true);
        assert.equal(result.blocked_tasks.length, 1);
        assert.equal(result.blocked_tasks[0].task.id, 'T-002');
        assert.equal(result.blocked_tasks[0].task.status, 'BLOCKED');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('getWhyBlocked includes suffixed task IDs from TASK.md rows', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'why-blocked-test-'));
    try {
        fs.writeFileSync(
            path.join(tmpDir, 'TASK.md'),
            makeTaskMd(['| T-500-1 | 🟥 BLOCKED | P1 | area | Suffixed task | me | 2026-01-01 | default | blocked_reason_code=CHILD_BLOCKED |']),
            'utf8'
        );

        const result = getWhyBlocked(tmpDir);
        assert.equal(result.has_blocked_tasks, true);
        assert.equal(result.blocked_tasks.length, 1);
        assert.equal(result.blocked_tasks[0].task.id, 'T-500-1');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('getWhyBlocked extracts blocked_reason_code from notes column', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'why-blocked-test-'));
    try {
        fs.writeFileSync(
            path.join(tmpDir, 'TASK.md'),
            makeTaskMd(['| T-003 | 🟥 BLOCKED | P2 | area | Some task | me | 2026-01-01 | strict | blocked_reason_code=REVIEW_DEPENDENCY |']),
            'utf8'
        );

        const result = getWhyBlocked(tmpDir);
        assert.equal(result.blocked_tasks.length, 1);

        const reasons = result.blocked_tasks[0].blocking_reasons;
        const explicitReason = reasons.find(function (r) { return r.reason_code === 'REVIEW_DEPENDENCY'; });
        assert.ok(explicitReason !== undefined, 'Expected blocking reason REVIEW_DEPENDENCY from notes');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('getWhyBlocked keeps blocked_reason_code when notes include escaped pipes', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'why-blocked-test-'));
    try {
        fs.writeFileSync(
            path.join(tmpDir, 'TASK.md'),
            makeTaskMd(['| T-003a | 🟥 BLOCKED | P2 | area | Some task | me | 2026-01-01 | strict | before \\| blocked_reason_code=REVIEW_DEPENDENCY |']),
            'utf8'
        );

        const result = getWhyBlocked(tmpDir);
        assert.equal(result.blocked_tasks.length, 1);

        const reasons = result.blocked_tasks[0].blocking_reasons;
        const explicitReason = reasons.find(function (r) { return r.reason_code === 'REVIEW_DEPENDENCY'; });
        assert.ok(explicitReason !== undefined, 'Expected blocking reason REVIEW_DEPENDENCY from notes after escaped pipe');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('getWhyBlocked detects IN_PROGRESS task with missing timeline events', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'why-blocked-test-'));
    const bundleDir = path.join(tmpDir, 'garda-agent-orchestrator');
    const eventsDir = path.join(bundleDir, 'runtime', 'task-events');

    try {
        fs.mkdirSync(eventsDir, { recursive: true });
        fs.writeFileSync(
            path.join(tmpDir, 'TASK.md'),
            makeTaskMd(['| T-010 | 🟨 IN_PROGRESS | P1 | area | Active task | me | 2026-01-01 | default | Notes |']),
            'utf8'
        );

        // Write a partial timeline (only TASK_MODE_ENTERED, missing RULE_PACK_LOADED etc.)
        const event = JSON.stringify({
            timestamp_utc: new Date().toISOString(),
            task_id: 'T-010',
            event_type: 'TASK_MODE_ENTERED',
            outcome: 'PASS',
            actor: 'orchestrator',
            message: 'Test'
        });
        fs.writeFileSync(path.join(eventsDir, 'T-010.jsonl'), event + '\n', 'utf8');

        const result = getWhyBlocked(tmpDir);
        assert.equal(result.has_blocked_tasks, true);
        assert.equal(result.in_progress_tasks.length, 1);

        const analysed = result.in_progress_tasks[0];
        assert.equal(analysed.task.id, 'T-010');
        assert.ok(analysed.missing_events.length > 0, 'Expected missing events for incomplete timeline');
        const timelineReason = analysed.blocking_reasons.find(function (reason) {
            return reason.reason_code === 'TIMELINE_INCOMPLETE';
        });
        assert.ok(timelineReason?.description.includes('task-cycle stall diagnostic'));
        assert.ok(result.summary_lines.includes(
            'Task-cycle stalls are task-level diagnostics; workspace readiness is reported separately by status.'
        ));
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('getWhyBlocked reports completion finalization locks for affected tasks', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'why-blocked-finalization-lock-test-'));
    const bundleDir = path.join(tmpDir, 'garda-agent-orchestrator');
    const reviewsDir = path.join(bundleDir, 'runtime', 'reviews');

    try {
        fs.mkdirSync(reviewsDir, { recursive: true });
        fs.writeFileSync(
            path.join(tmpDir, 'TASK.md'),
            makeTaskMd(['| T-012 | 🟧 IN_REVIEW | P1 | area | Completion task | me | 2026-01-01 | default | Notes |']),
            'utf8'
        );

        const lockPath = path.join(reviewsDir, 'T-012-completion-gate.lock');
        fs.mkdirSync(lockPath, { recursive: true });
        fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
            pid: process.pid,
            hostname: os.hostname(),
            created_at_utc: new Date().toISOString()
        }, null, 2), 'utf8');

        const result = getWhyBlocked(tmpDir);
        assert.equal(result.has_blocked_tasks, true);
        assert.ok((result.completion_finalization_lock_observations || []).length > 0);
        assert.equal(result.completion_finalization_lock_observations![0].task_id, 'T-012');
        assert.ok(result.in_progress_tasks[0].blocking_reasons.some(function (reason) {
            return reason.reason_code === 'ACTIVE_COMPLETION_FINALIZATION_LOCK';
        }));
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('getWhyBlocked reports stale completion finalization locks for affected tasks', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'why-blocked-finalization-lock-stale-test-'));
    const bundleDir = path.join(tmpDir, 'garda-agent-orchestrator');
    const reviewsDir = path.join(bundleDir, 'runtime', 'reviews');

    try {
        fs.mkdirSync(reviewsDir, { recursive: true });
        fs.writeFileSync(
            path.join(tmpDir, 'TASK.md'),
            makeTaskMd(['| T-013 | 🟧 IN_REVIEW | P1 | area | Completion task stale lock | me | 2026-01-01 | default | Notes |']),
            'utf8'
        );

        const lockPath = path.join(reviewsDir, 'T-013-completion-gate.lock');
        fs.mkdirSync(lockPath, { recursive: true });
        fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
            pid: 999999,
            hostname: os.hostname(),
            created_at_utc: '2026-03-30T10:00:00.000Z'
        }, null, 2), 'utf8');
        const oldTime = new Date(Date.now() - (31 * 60 * 1000));
        fs.utimesSync(lockPath, oldTime, oldTime);

        const result = getWhyBlocked(tmpDir);
        assert.equal(result.has_blocked_tasks, true);
        assert.ok((result.completion_finalization_lock_observations || []).length > 0);
        assert.equal(result.completion_finalization_lock_observations![0].task_id, 'T-013');
        assert.equal(result.completion_finalization_lock_observations![0].stale, true);
        assert.ok(result.in_progress_tasks[0].blocking_reasons.some(function (reason) {
            return reason.reason_code === 'STALE_COMPLETION_FINALIZATION_LOCK';
        }));
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('getWhyBlocked preserves healthy output when a complete timeline contains malformed lines', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'why-blocked-test-'));
    const bundleDir = path.join(tmpDir, 'garda-agent-orchestrator');
    const eventsDir = path.join(bundleDir, 'runtime', 'task-events');

    try {
        fs.mkdirSync(eventsDir, { recursive: true });
        fs.writeFileSync(
            path.join(tmpDir, 'TASK.md'),
            makeTaskMd(['| T-011 | 🟨 IN_PROGRESS | P1 | area | Healthy task | me | 2026-01-01 | default | Notes |']),
            'utf8'
        );

        // Write complete non-code-change timeline
        const events = [
            'TASK_MODE_ENTERED', 'RULE_PACK_LOADED', 'HANDSHAKE_DIAGNOSTICS_RECORDED', 'SHELL_SMOKE_PREFLIGHT_RECORDED', 'PREFLIGHT_CLASSIFIED', 'IMPLEMENTATION_STARTED', 'COMPILE_GATE_PASSED',
            'REVIEW_PHASE_STARTED', 'REVIEW_GATE_PASSED', 'COMPLETION_GATE_PASSED'
        ];
        const lines = events.map(function (eventType) {
            return JSON.stringify({
                timestamp_utc: new Date().toISOString(),
                task_id: 'T-011',
                event_type: eventType,
                outcome: 'PASS',
                actor: 'gate',
                message: 'Test'
            });
        });
        lines.splice(2, 0, 'not-json');
        fs.writeFileSync(path.join(eventsDir, 'T-011.jsonl'), lines.join('\n') + '\n', 'utf8');

        const result = getWhyBlocked(tmpDir);
        // With complete timeline and no failed gates => not stalled
        assert.equal(result.in_progress_tasks.length, 0);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('getWhyBlocked does not stall docs-only tasks when canonical non-code review phase is present', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'why-blocked-test-'));
    const bundleDir = path.join(tmpDir, 'garda-agent-orchestrator');
    const eventsDir = path.join(bundleDir, 'runtime', 'task-events');
    const reviewsDir = path.join(bundleDir, 'runtime', 'reviews');

    try {
        fs.mkdirSync(eventsDir, { recursive: true });
        fs.mkdirSync(reviewsDir, { recursive: true });
        fs.writeFileSync(
            path.join(tmpDir, 'TASK.md'),
            makeTaskMd(['| T-012 | 🟨 IN_PROGRESS | P1 | docs | Docs-only task | me | 2026-01-01 | default | Notes |']),
            'utf8'
        );
        fs.writeFileSync(
            path.join(reviewsDir, 'T-012-preflight.json'),
            JSON.stringify({
                task_id: 'T-012',
                changed_files: ['docs/runbook.md'],
                metrics: {
                    changed_lines_total: 8
                },
                required_reviews: {
                    code: false,
                    test: false
                }
            }, null, 2),
            'utf8'
        );

        const events = [
            'TASK_MODE_ENTERED',
            'RULE_PACK_LOADED',
            'HANDSHAKE_DIAGNOSTICS_RECORDED',
            'SHELL_SMOKE_PREFLIGHT_RECORDED',
            'PREFLIGHT_CLASSIFIED',
            'IMPLEMENTATION_STARTED',
            'COMPILE_GATE_PASSED',
            'REVIEW_PHASE_STARTED',
            'REVIEW_GATE_PASSED',
            'COMPLETION_GATE_PASSED'
        ];
        const lines = events.map(function (eventType) {
            return JSON.stringify({
                timestamp_utc: new Date().toISOString(),
                task_id: 'T-012',
                event_type: eventType,
                outcome: 'PASS',
                actor: 'gate',
                message: 'Test'
            });
        });
        fs.writeFileSync(path.join(eventsDir, 'T-012.jsonl'), lines.join('\n') + '\n', 'utf8');

        const result = getWhyBlocked(tmpDir);
        assert.equal(result.in_progress_tasks.length, 0);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('getWhyBlocked surfaces stale task-event lock as blocking reason for matching task', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'why-blocked-lock-test-'));
    const bundleDir = path.join(tmpDir, 'garda-agent-orchestrator');
    const eventsDir = path.join(bundleDir, 'runtime', 'task-events');

    try {
        fs.mkdirSync(path.join(eventsDir, '.T-005.lock'), { recursive: true });
        fs.writeFileSync(
            path.join(tmpDir, 'TASK.md'),
            makeTaskMd(['| T-005 | 🟨 IN_PROGRESS | P1 | area | Active task | me | 2026-01-01 | default | Notes |']),
            'utf8'
        );
        fs.writeFileSync(path.join(eventsDir, '.T-005.lock', 'owner.json'), JSON.stringify({
            pid: 999999,
            hostname: os.hostname(),
            created_at_utc: '2026-03-30T10:00:00.000Z'
        }, null, 2) + '\n', 'utf8');

        const result = getWhyBlocked(tmpDir);
        assert.equal(result.in_progress_tasks.length, 1);
        assert.equal(result.lock_observations.length, 1);
        assert.ok(result.in_progress_tasks[0].blocking_reasons.some(function (reason) {
            return reason.reason_code === 'STALE_TASK_EVENT_LOCK';
        }));
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('getWhyBlocked surfaces stale review-artifact lock as blocking reason for matching task', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'why-blocked-review-lock-test-'));
    const bundleDir = path.join(tmpDir, 'garda-agent-orchestrator');
    const reviewsDir = path.join(bundleDir, 'runtime', 'reviews');
    const lockPath = path.join(reviewsDir, 'T-014-code.md.lock');

    try {
        fs.mkdirSync(lockPath, { recursive: true });
        fs.writeFileSync(
            path.join(tmpDir, 'TASK.md'),
            makeTaskMd(['| T-014 | 🟨 IN_PROGRESS | P1 | area | Active task | me | 2026-01-01 | default | Notes |']),
            'utf8'
        );
        fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
            pid: 999999,
            hostname: os.hostname(),
            created_at_utc: '2026-03-30T10:00:00.000Z'
        }, null, 2) + '\n', 'utf8');
        const oldTime = new Date(Date.now() - (31 * 60 * 1000));
        fs.utimesSync(lockPath, oldTime, oldTime);

        const result = getWhyBlocked(tmpDir);
        assert.equal(result.in_progress_tasks.length, 1);
        assert.equal(result.review_lock_observations?.length, 1);
        assert.ok(result.in_progress_tasks[0].blocking_reasons.some(function (reason) {
            return reason.reason_code === 'STALE_REVIEW_ARTIFACT_LOCK';
        }));
        assert.ok(result.in_progress_tasks[0].related_review_locks?.some((lock) => lock.lock_name === 'T-014-code.md.lock'));
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('getWhyBlocked surfaces the shared stale reviews-index lock for in-progress tasks', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'why-blocked-review-index-lock-test-'));
    const bundleDir = path.join(tmpDir, 'garda-agent-orchestrator');
    const runtimeDir = path.join(bundleDir, 'runtime');
    const lockPath = path.join(runtimeDir, '.reviews-index.lock');

    try {
        fs.mkdirSync(lockPath, { recursive: true });
        fs.writeFileSync(
            path.join(tmpDir, 'TASK.md'),
            makeTaskMd(['| T-015 | 🟨 IN_PROGRESS | P1 | area | Active task | me | 2026-01-01 | default | Notes |']),
            'utf8'
        );
        fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
            pid: 999999,
            hostname: os.hostname(),
            created_at_utc: '2026-03-30T10:00:00.000Z'
        }, null, 2) + '\n', 'utf8');
        const oldTime = new Date(Date.now() - (31 * 60 * 1000));
        fs.utimesSync(lockPath, oldTime, oldTime);

        const result = getWhyBlocked(tmpDir);
        assert.equal(result.in_progress_tasks.length, 1);
        assert.ok(result.review_lock_observations?.some((lock) => lock.lock_name === '.reviews-index.lock'));
        assert.ok(result.in_progress_tasks[0].related_review_locks?.some((lock) => lock.lock_name === '.reviews-index.lock'));
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('getWhyBlocked marks code-changing tasks stalled when handshake lifecycle evidence is missing', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'why-blocked-code-test-'));
    const bundleDir = path.join(tmpDir, 'garda-agent-orchestrator');
    const eventsDir = path.join(bundleDir, 'runtime', 'task-events');
    const reviewsDir = path.join(bundleDir, 'runtime', 'reviews');

    try {
        fs.mkdirSync(eventsDir, { recursive: true });
        fs.mkdirSync(reviewsDir, { recursive: true });
        fs.writeFileSync(
            path.join(tmpDir, 'TASK.md'),
            makeTaskMd(['| T-013 | 🟨 IN_PROGRESS | P1 | runtime | Code task | me | 2026-01-01 | default | Notes |']),
            'utf8'
        );
        fs.writeFileSync(
            path.join(reviewsDir, 'T-013-preflight.json'),
            JSON.stringify({
                task_id: 'T-013',
                changed_files: ['src/main.ts'],
                scope_category: 'code',
                metrics: {
                    changed_lines_total: 8,
                    code_like_changed_count: 1,
                    runtime_code_like_changed_count: 1
                },
                required_reviews: {
                    code: true,
                    test: false
                }
            }, null, 2),
            'utf8'
        );

        const events = [
            'TASK_MODE_ENTERED',
            'RULE_PACK_LOADED',
            'PREFLIGHT_CLASSIFIED',
            'IMPLEMENTATION_STARTED',
            'COMPILE_GATE_PASSED',
            'REVIEW_PHASE_STARTED',
            'REVIEW_GATE_PASSED',
            'COMPLETION_GATE_PASSED'
        ];
        const lines = events.map(function (eventType) {
            return JSON.stringify({
                timestamp_utc: new Date().toISOString(),
                task_id: 'T-013',
                event_type: eventType,
                outcome: 'PASS',
                actor: 'gate',
                message: 'Test'
            });
        });
        fs.writeFileSync(path.join(eventsDir, 'T-013.jsonl'), lines.join('\n') + '\n', 'utf8');

        const result = getWhyBlocked(tmpDir);
        assert.equal(result.in_progress_tasks.length, 1);
        assert.ok(result.in_progress_tasks[0].missing_events.includes('HANDSHAKE_DIAGNOSTICS_RECORDED'));
        assert.ok(result.in_progress_tasks[0].missing_events.includes('SHELL_SMOKE_PREFLIGHT_RECORDED'));
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('getWhyBlocked accepts terminal full-suite events as satisfying the synthetic lifecycle marker', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'why-blocked-full-suite-test-'));
    const bundleDir = path.join(tmpDir, 'garda-agent-orchestrator');
    const eventsDir = path.join(bundleDir, 'runtime', 'task-events');
    const configDir = path.join(bundleDir, 'live', 'config');

    try {
        fs.mkdirSync(eventsDir, { recursive: true });
        fs.mkdirSync(configDir, { recursive: true });
        fs.writeFileSync(
            path.join(configDir, 'workflow-config.json'),
            JSON.stringify({
                full_suite_validation: {
                    enabled: true,
                    command: 'npm test'
                }
            }, null, 2),
            'utf8'
        );
        fs.writeFileSync(
            path.join(tmpDir, 'TASK.md'),
            makeTaskMd(['| T-016 | 🟨 IN_PROGRESS | P1 | area | Full suite warned task | me | 2026-01-01 | default | Notes |']),
            'utf8'
        );

        const events = [
            'TASK_MODE_ENTERED',
            'RULE_PACK_LOADED',
            'HANDSHAKE_DIAGNOSTICS_RECORDED',
            'SHELL_SMOKE_PREFLIGHT_RECORDED',
            'PREFLIGHT_CLASSIFIED',
            'IMPLEMENTATION_STARTED',
            'COMPILE_GATE_PASSED',
            'REVIEW_PHASE_STARTED',
            'REVIEW_GATE_PASSED',
            'FULL_SUITE_VALIDATION_WARNED'
        ];
        const lines = events.map(function (eventType) {
            return JSON.stringify({
                timestamp_utc: new Date().toISOString(),
                task_id: 'T-016',
                event_type: eventType,
                outcome: eventType === 'FULL_SUITE_VALIDATION_WARNED' ? 'WARN' : 'PASS',
                actor: 'gate',
                message: 'Test'
            });
        });
        fs.writeFileSync(path.join(eventsDir, 'T-016.jsonl'), lines.join('\n') + '\n', 'utf8');

        const result = getWhyBlocked(tmpDir);
        assert.equal(result.in_progress_tasks.length, 1);
        assert.ok(!result.in_progress_tasks[0].missing_events.includes('FULL_SUITE_VALIDATION_COMPLETE'));
        assert.ok(result.in_progress_tasks[0].missing_events.includes('COMPLETION_GATE_PASSED'));
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('getWhyBlocked reports full-suite failures as failed gates instead of missing lifecycle evidence', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'why-blocked-full-suite-failed-test-'));
    const bundleDir = path.join(tmpDir, 'garda-agent-orchestrator');
    const eventsDir = path.join(bundleDir, 'runtime', 'task-events');
    const configDir = path.join(bundleDir, 'live', 'config');

    try {
        fs.mkdirSync(eventsDir, { recursive: true });
        fs.mkdirSync(configDir, { recursive: true });
        fs.writeFileSync(
            path.join(configDir, 'workflow-config.json'),
            JSON.stringify({
                full_suite_validation: {
                    enabled: true,
                    command: 'npm test'
                }
            }, null, 2),
            'utf8'
        );
        fs.writeFileSync(
            path.join(tmpDir, 'TASK.md'),
            makeTaskMd(['| T-017 | 🟨 IN_PROGRESS | P1 | area | Full suite failed task | me | 2026-01-01 | default | Notes |']),
            'utf8'
        );

        const events = [
            'TASK_MODE_ENTERED',
            'RULE_PACK_LOADED',
            'HANDSHAKE_DIAGNOSTICS_RECORDED',
            'SHELL_SMOKE_PREFLIGHT_RECORDED',
            'PREFLIGHT_CLASSIFIED',
            'IMPLEMENTATION_STARTED',
            'COMPILE_GATE_PASSED',
            'REVIEW_PHASE_STARTED',
            'REVIEW_GATE_PASSED',
            'FULL_SUITE_VALIDATION_FAILED'
        ];
        const lines = events.map(function (eventType) {
            return JSON.stringify({
                timestamp_utc: new Date().toISOString(),
                task_id: 'T-017',
                event_type: eventType,
                outcome: eventType === 'FULL_SUITE_VALIDATION_FAILED' ? 'FAIL' : 'PASS',
                actor: 'gate',
                message: 'Test'
            });
        });
        fs.writeFileSync(path.join(eventsDir, 'T-017.jsonl'), lines.join('\n') + '\n', 'utf8');

        const result = getWhyBlocked(tmpDir);
        assert.equal(result.in_progress_tasks.length, 1);
        assert.ok(result.in_progress_tasks[0].failed_gates.includes('FULL_SUITE_VALIDATION_FAILED'));
        assert.ok(!result.in_progress_tasks[0].missing_events.includes('FULL_SUITE_VALIDATION_COMPLETE'));
        assert.ok(result.in_progress_tasks[0].blocking_reasons.some(function (reason) {
            return reason.reason_code === 'FULL_SUITE_VALIDATION_FAILED';
        }));
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('getWhyBlocked renders compile-gate remediation without stale fallback commands', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'why-blocked-compile-gate-test-'));
    const bundleDir = path.join(tmpDir, 'garda-agent-orchestrator');
    const eventsDir = path.join(bundleDir, 'runtime', 'task-events');

    try {
        fs.mkdirSync(eventsDir, { recursive: true });
        fs.writeFileSync(
            path.join(tmpDir, 'TASK.md'),
            makeTaskMd(['| T-018 | 🟨 IN_PROGRESS | P1 | runtime | Compile failed task | me | 2026-01-01 | strict | Notes |']),
            'utf8'
        );

        const events = [
            'TASK_MODE_ENTERED',
            'RULE_PACK_LOADED',
            'HANDSHAKE_DIAGNOSTICS_RECORDED',
            'SHELL_SMOKE_PREFLIGHT_RECORDED',
            'PREFLIGHT_CLASSIFIED',
            'IMPLEMENTATION_STARTED',
            'COMPILE_GATE_FAILED'
        ];
        const lines = events.map(function (eventType) {
            return JSON.stringify({
                timestamp_utc: new Date().toISOString(),
                task_id: 'T-018',
                event_type: eventType,
                outcome: eventType === 'COMPILE_GATE_FAILED' ? 'FAIL' : 'PASS',
                actor: 'gate',
                message: 'Test'
            });
        });
        fs.writeFileSync(path.join(eventsDir, 'T-018.jsonl'), lines.join('\n') + '\n', 'utf8');

        const result = getWhyBlocked(tmpDir);
        assert.equal(result.in_progress_tasks.length, 1);
        const compileGateReason = result.in_progress_tasks[0].blocking_reasons.find((reason) => reason.reason_code === 'COMPILE_GATE_FAILED');
        assert.ok(compileGateReason);
        assert.match(compileGateReason.remediation, /configured compile\/build\/type-check command/u);
        assert.match(compileGateReason.remediation, /gate compile-gate --task-id "T-018" --preflight-path "garda-agent-orchestrator\/runtime\/reviews\/T-018-preflight\.json"/u);
        assert.doesNotMatch(compileGateReason.remediation, /npm run build/u);
        assert.doesNotMatch(compileGateReason.remediation, /--commands-path/u);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

// ── formatWhyBlockedResult ────────────────────────────────────────────────────

test('formatWhyBlockedResult says no blocked tasks when result is clean', () => {
    const result: WhyBlockedResult = {
        has_blocked_tasks: false,
        blocked_tasks: [],
        in_progress_tasks: [],
        lock_observations: [],
        summary_lines: ['No blocked or stalled tasks found.']
    };

    const output = formatWhyBlockedResult(result);
    assert.ok(output.includes('WhyBlocked'));
    assert.ok(output.includes('No blocked or stalled tasks found.'));
});

test('formatWhyBlockedResult renders BLOCKED task section', () => {
    const result: WhyBlockedResult = {
        has_blocked_tasks: true,
        blocked_tasks: [{
            task: {
                id: 'T-050',
                status: 'BLOCKED',
                priority: 'P1',
                area: 'cli',
                title: 'Test blocked task',
                owner: 'me',
                updated: '2026-01-01',
                profile: 'default',
                notes: ''
            },
            blocking_reasons: [{
                reason_code: 'EXTERNAL_DEPENDENCY',
                description: 'Depends on external API',
                remediation: 'Wait for API team.'
            }],
            missing_events: [],
            failed_gates: [],
            timeline_status: 'MISSING',
            related_locks: []
        }],
        in_progress_tasks: [],
        lock_observations: [],
        summary_lines: ['Blocked tasks: 1']
    };

    const output = formatWhyBlockedResult(result);
    assert.ok(output.includes('BLOCKED: T-050'));
    assert.ok(output.includes('Test blocked task'));
    assert.ok(output.includes('[EXTERNAL_DEPENDENCY]'));
    assert.ok(output.includes('Wait for API team.'));
    assert.ok(output.includes('Blocked tasks: 1'));
});

test('formatWhyBlockedResult renders STALLED task with missing events', () => {
    const result: WhyBlockedResult = {
        has_blocked_tasks: true,
        blocked_tasks: [],
        in_progress_tasks: [{
            task: {
                id: 'T-020',
                status: 'IN_PROGRESS',
                priority: 'P2',
                area: 'cli',
                title: 'Stalled task',
                owner: 'me',
                updated: '2026-01-01',
                profile: 'strict',
                notes: ''
            },
            blocking_reasons: [{
                reason_code: 'TIMELINE_INCOMPLETE',
                description: 'Missing 2 events',
                remediation: 'Re-run gate commands.'
            }],
            missing_events: ['COMPILE_GATE_PASSED', 'REVIEW_PHASE_STARTED'],
            failed_gates: [],
            timeline_status: 'PRESENT',
            related_locks: [{
                lock_name: '.T-020.lock',
                lock_path: '/tmp/test/runtime/task-events/.T-020.lock',
                scope: 'task' as const,
                task_id: 'T-020',
                status: 'STALE' as const,
                age_ms: 1200,
                heartbeat_age_ms: 1200,
                owner_file_age_ms: 1200,
                lock_dir_age_ms: 1200,
                freshness_source: 'heartbeat',
                owner_pid: 999999,
                owner_hostname: 'stale-host',
                owner_created_at_utc: '2026-03-30T10:00:00.000Z',
                owner_alive: false,
                owner_metadata_status: 'ok',
                stale_reason: 'owner_dead',
                remediation: 'Run doctor cleanup.'
            }],
            related_review_locks: [{
                lock_name: 'T-020-code.md.lock',
                lock_path: '/tmp/test/runtime/reviews/T-020-code.md.lock',
                artifact_path: '/tmp/test/runtime/reviews/T-020-code.md',
                task_id: 'T-020',
                artifact_type: 'code.md',
                status: 'ACTIVE' as const,
                age_ms: 500,
                owner_pid: 4242,
                owner_hostname: 'active-host',
                owner_created_at_utc: '2026-03-30T10:00:00.000Z',
                owner_alive: true,
                owner_metadata_status: 'ok',
                stale_reason: null,
                remediation: 'Wait for owner.'
            }],
            related_completion_finalization_locks: [{
                active: false,
                lock_name: 'T-020-completion-gate.lock',
                lock_path: '/tmp/test/runtime/reviews/T-020-completion-gate.lock',
                task_id: 'T-020',
                age_ms: 90000,
                owner_pid: 1111,
                owner_hostname: 'stale-finalizer',
                owner_created_at_utc: '2026-03-30T10:00:00.000Z',
                owner_alive: false,
                owner_metadata_status: 'ok',
                stale: true,
                stale_reason: 'owner_dead',
                remediation: 'Verify stale finalization lock and rerun completion-gate.',
                subsystem_scope_note: 'completion finalization scope note',
                acquisition_policy: {
                    timeout_ms: 5000,
                    retry_ms: 50,
                    stale_after_ms: 900000
                }
            }]
        }],
        lock_observations: [{
            lock_name: '.T-020.lock',
            lock_path: '/tmp/test/runtime/task-events/.T-020.lock',
            scope: 'task' as const,
            task_id: 'T-020',
            status: 'STALE' as const,
            age_ms: 1200,
            heartbeat_age_ms: 1200,
            owner_file_age_ms: 1200,
            lock_dir_age_ms: 1200,
            freshness_source: 'heartbeat',
            owner_pid: 999999,
            owner_hostname: 'stale-host',
            owner_created_at_utc: '2026-03-30T10:00:00.000Z',
            owner_alive: false,
            owner_metadata_status: 'ok',
            stale_reason: 'owner_dead',
            remediation: 'Run doctor cleanup.'
        }],
        review_lock_observations: [{
            lock_name: 'T-020-code.md.lock',
            lock_path: '/tmp/test/runtime/reviews/T-020-code.md.lock',
            artifact_path: '/tmp/test/runtime/reviews/T-020-code.md',
            task_id: 'T-020',
            artifact_type: 'code.md',
            status: 'ACTIVE' as const,
            age_ms: 500,
            owner_pid: 4242,
            owner_hostname: 'active-host',
            owner_created_at_utc: '2026-03-30T10:00:00.000Z',
            owner_alive: true,
            owner_metadata_status: 'ok',
            stale_reason: null,
            remediation: 'Wait for owner.'
        }],
        completion_finalization_lock_observations: [{
            active: false,
            lock_name: 'T-020-completion-gate.lock',
            lock_path: '/tmp/test/runtime/reviews/T-020-completion-gate.lock',
            task_id: 'T-020',
            age_ms: 90000,
            owner_pid: 1111,
            owner_hostname: 'stale-finalizer',
            owner_created_at_utc: '2026-03-30T10:00:00.000Z',
            owner_alive: false,
            owner_metadata_status: 'ok',
            stale: true,
            stale_reason: 'owner_dead',
            remediation: 'Verify stale finalization lock and rerun completion-gate.',
            subsystem_scope_note: 'completion finalization scope note',
            acquisition_policy: {
                timeout_ms: 5000,
                retry_ms: 50,
                stale_after_ms: 900000
            }
        }],
        summary_lines: ['In-progress tasks with gate issues: 1']
    };

    const output = formatWhyBlockedResult(result);
    assert.ok(output.includes('Task-Event Locks'));
    assert.ok(output.includes('Review Artifact Locks'));
    assert.ok(output.includes('Completion Finalization Locks'));
    assert.ok(output.includes('STALLED: T-020'));
    assert.ok(output.includes('Related locks: .T-020.lock:STALE'));
    assert.ok(output.includes('Related review locks: T-020-code.md.lock:ACTIVE'));
    assert.ok(output.includes('Related completion finalization locks: T-020-completion-gate.lock:STALE'));
    assert.ok(output.includes('COMPILE_GATE_PASSED'));
    assert.ok(output.includes('REVIEW_PHASE_STARTED'));
    assert.ok(output.includes('[TIMELINE_INCOMPLETE]'));
});
