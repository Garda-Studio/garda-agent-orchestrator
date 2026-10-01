import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import { appendTaskEvent } from '../../../src/gate-runtime/task-events';
import { buildTaskEventsSummary, type TaskEventsSummaryResult } from '../../../src/gates/task-events-summary';
import { buildReportTaskDetail, buildSkippedTaskDetail } from '../../../src/reports/report-data/task-detail';
import { buildReportTaskTimeline, MAX_TASK_TIMELINE_EVENTS, MAX_TASK_TIMELINE_DETAILS_CHARS, type ReportTaskTimeline } from '../../../src/reports/report-data/task-timeline';
import { UI_DASHBOARD_CLIENT_CORE } from '../../../src/reports/ui/dashboard/dashboard-client-core';
import { UI_DASHBOARD_CLIENT_TASK_DETAIL } from '../../../src/reports/ui/dashboard/dashboard-client-task-detail';
import { LOCAL_UI_LANGUAGES, LOCAL_UI_TEXT, LOCAL_UI_TASK_PROGRESS_TEXT } from '../../../src/reports/ui/ui-i18n';
import { makeLocalUiTempRepo, writeLocalUiRepoFixture } from './local-ui-test-helpers';

const TIMESTAMP = '2026-10-01T10:00:00.000Z';
type TimelineEvent = TaskEventsSummaryResult['timeline'][number];

function summary(events: Array<Partial<TimelineEvent>>): TaskEventsSummaryResult {
    return {
        task_id: 'T-100', source_path: 'runtime/task-events/T-100.jsonl', events_count: events.length,
        parse_errors: 0, integrity: { status: 'PASS', integrity_event_count: events.length, legacy_event_count: 0, violations: [] },
        event_contract: { schema_version: 2, legacy_schema_versions: [1], current_schema_event_count: events.length,
            legacy_schema_event_count: 0, unknown_schema_version_count: 0 },
        command_policy_warnings: [], command_policy_warning_count: 0,
        first_event_utc: TIMESTAMP, last_event_utc: TIMESTAMP, token_economy: null,
        timeline: events.map((event, index) => ({ index: index + 1, timestamp_utc: TIMESTAMP, schema_version: 2,
            event_source: 'gate', event_type: 'UNKNOWN', outcome: 'INFO', actor: 'gate', message: '',
            lifecycle_phase: 'unknown', health_state: 'neutral', terminal_outcome: 'none',
            normalized_from_legacy: false, unknown_schema_version: false, details: {}, ...event }))
    };
}

function renderTimeline(timeline: unknown, language = 'en', fullDetail = false): string {
    const detail = { task_id: 'T-100', timeline, stats: {}, audit: {}, full_suite_validation: {}, artifact_links: [] };
    const detailNode = { innerHTML: '', querySelectorAll: () => [] };
    const context = vm.createContext({
        window: { localStorage: null }, navigator: { language, languages: [] },
        languageMetadata: LOCAL_UI_LANGUAGES, languagePacks: LOCAL_UI_TEXT, fallbackLanguage: 'en', initialLanguage: language,
        detail, detailNode, document: { querySelectorAll: () => [], getElementById: () => null },
        actionsEnabled: false, actionToken: 'timeline-token',
        findReportTask: () => ({ task_id: 'T-100', title: 'History', status_token: 'IN_PROGRESS' }),
        artifactList: () => '', fetch: () => { throw new Error('Timeline rendering must not request or execute anything'); }
    });
    vm.runInContext(UI_DASHBOARD_CLIENT_CORE + UI_DASHBOARD_CLIENT_TASK_DETAIL, context);
    if (fullDetail) {
        vm.runInContext('renderTaskDetail(detail)', context);
        return detailNode.innerHTML;
    }
    return vm.runInContext('taskTimeline(detail)', context) as string;
}

test('canonical report history preserves equal-time sequence, failed review retries and resumed cycles without writing history', (context) => {
    const root = makeLocalUiTempRepo();
    writeLocalUiRepoFixture(root);
    context.mock.method(Date.prototype, 'toISOString', () => TIMESTAMP);
    const eventRoot = path.join(root, 'garda-agent-orchestrator/runtime/task-events');
    const events: Array<[string, string, string, unknown]> = [
        ['TASK_MODE_ENTERED', 'PASS', 'First cycle', {}],
        ['REVIEWER_DELEGATION_STARTED', 'INFO', 'Reviewer one', { review_type: 'code' }],
        ['REVIEW_RECORDED', 'FAIL', 'Review failed', { review_type: 'code', verdict: 'REVIEW FAILED' }],
        ['REVIEW_PHASE_STARTED', 'INFO', 'Prepare retry', { review_type: 'code' }],
        ['REVIEWER_DELEGATION_STARTED', 'INFO', 'Reviewer two', { review_type: 'code' }],
        ['REVIEW_RECORDED', 'PASS', 'Review passed', { review_type: 'code', verdict: 'REVIEW PASSED' }],
        ['COHERENT_CYCLE_RESTARTED', 'PASS', 'Resumed after restart', {}],
        ['REVIEWER_DELEGATION_STARTED', 'INFO', 'Resumed reviewer', { review_type: 'code' }],
        ['CUSTOM_EVENT', 'UNKNOWN', 'Original message <img onerror="bad()">', { command: 'node original-command' }]
    ];
    for (const [type, outcome, message, details] of events) assert.equal(appendTaskEvent(root, 'T-100', type, outcome, message, details, { eventsRoot: eventRoot, passThru: true })?.canonical_committed, true);
    const file = path.join(eventRoot, 'T-100.jsonl');
    const before = fs.readFileSync(file, 'utf8');
    const detail = buildReportTaskDetail({ repoRoot: root, taskId: 'T-100', eventsRoot: eventRoot });
    const history = detail.timeline!;
    assert.equal(history.incomplete, false);
    assert.equal(history.latest_cycle, 2);
    assert.deepEqual(history.events.map(event => event.index), events.map((_, index) => index + 1));
    assert.ok(history.events.every(event => event.timestamp_utc === TIMESTAMP));
    assert.deepEqual(history.events.filter(event => event.event_type === 'REVIEWER_DELEGATION_STARTED').map(event => event.review_attempt), [1, 2, 1]);
    assert.equal(history.events[3].review_attempt, null);
    assert.deepEqual(history.events.filter(event => event.event_type === 'REVIEW_RECORDED').map(event => event.outcome), ['FAIL', 'PASS']);
    assert.equal(history.source_path, 'garda-agent-orchestrator/runtime/task-events/T-100.jsonl');
    assert.equal(detail.latest_cycle_events?.mode, 'compact_latest_cycle');
    const modelBefore = JSON.stringify(history);
    const html = renderTimeline(history, 'en', true);
    assert.match(html, /Recorded cycle 1 · earlier/u);
    assert.match(html, /Recorded cycle 2 · latest/u);
    assert.match(html, /code review · attempt 2/u);
    assert.match(html, /Workflow cycle restarted/u);
    assert.match(html, /CUSTOM_EVENT/u);
    assert.match(html, /no description is available/u);
    assert.match(html, /&lt;img onerror=/u);
    assert.doesNotMatch(html, /<img/u);
    const rawLink = new URL(html.match(/href="([^"]+T-100.jsonl[^"]*)"/u)![1], 'http://localhost');
    assert.equal(rawLink.pathname, '/files');
    assert.equal(rawLink.searchParams.get('path'), history.source_path);
    assert.equal(rawLink.searchParams.get('action_token'), 'timeline-token');
    assert.match(html, /<details><summary>Task events · JSON/u);
    assert.match(html, /<details><summary>Gate Timeline · JSON/u);
    assert.match(html, /compact_latest_cycle/u);
    assert.deepEqual(buildReportTaskDetail({ repoRoot: root, taskId: 'T-100', eventsRoot: eventRoot }).timeline, history);
    assert.equal(JSON.stringify(history), modelBefore);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    assert.equal(buildSkippedTaskDetail('T-100', 0).timeline, null);
});

test('unknown types including object-prototype names remain honest visible events', () => {
    const history = buildReportTaskTimeline(summary([{ event_type: 'TASK_MODE_ENTERED' }, ...['FUTURE_EVENT', '__proto__', 'constructor'].map(event_type => ({ event_type }))]));
    for (const event of history.events.slice(1)) {
        assert.equal(typeof event.description, 'string');
        assert.match(event.description, /no description is available/u);
        assert.ok(renderTimeline(history).includes(event.event_type));
    }
});

test('missing and malformed details and times remain visible without invented review attempts', () => {
    const source = summary([{ event_type: 'TASK_MODE_ENTERED' },
        ...[null, 'Original details', ['Original array'], undefined].map(details => ({ event_type: 'REVIEWER_DELEGATION_STARTED', details })),
        { event_type: 'FUTURE_EVENT', timestamp_utc: null }, { event_type: 'FUTURE_EVENT', timestamp_utc: '<bad-time>' }]);
    const history = buildReportTaskTimeline(source);
    assert.ok(history.events.slice(1, 5).every(event => event.review_type === null && event.review_attempt === null));
    assert.equal(JSON.parse(history.events[2].details_json).details, 'Original details');
    assert.deepEqual(JSON.parse(history.events[3].details_json).details, ['Original array']);
    assert.equal(history.incomplete, true);
    assert.ok(history.diagnostics.some(message => message.includes('missing or invalid recorded time')));
    const html = renderTimeline(history);
    assert.match(html, /Recorded time unavailable/u);
    assert.match(html, /&lt;bad-time&gt;/u);
    assert.doesNotMatch(html, /datetime="&lt;bad-time&gt;"/u);
});

test('malformed canonical lines and failed integrity are marked as incomplete while valid history stays visible', () => {
    const root = makeLocalUiTempRepo();
    const eventRoot = path.join(root, 'runtime/task-events');
    assert.equal(appendTaskEvent(root, 'T-100', 'TASK_MODE_ENTERED', 'PASS', 'Started', {}, { eventsRoot: eventRoot, passThru: true })?.canonical_committed, true);
    const file = path.join(eventRoot, 'T-100.jsonl');
    fs.appendFileSync(file, 'malformed JSON\n');
    const before = fs.readFileSync(file, 'utf8');
    const history = buildReportTaskTimeline(buildTaskEventsSummary({ repoRoot: root, taskId: 'T-100', eventsRoot: eventRoot }));
    assert.equal(history.incomplete, true);
    assert.equal(history.events.length, 1);
    assert.ok(history.diagnostics.some(message => message.includes('1 malformed event line')));
    assert.ok(history.diagnostics.some(message => message.includes('Canonical event integrity: FAILED')));
    assert.match(renderTimeline(history), /Incomplete evidence/u);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('large histories keep the last bounded window and bounded original-detail previews', () => {
    const details = { payload: 'x'.repeat(1_000_000), nested: { next: { next: { next: { next: { next: { original: true } } } } } } };
    const source = summary(Array.from({ length: 10_000 }, (_, index) => ({ event_type: index === 0 ? 'TASK_MODE_ENTERED' : 'CUSTOM_EVENT', details })));
    const history = buildReportTaskTimeline(source);
    assert.equal(history.events.length, MAX_TASK_TIMELINE_EVENTS);
    assert.equal(history.omitted_events, 10_000 - MAX_TASK_TIMELINE_EVENTS);
    assert.equal(history.events[0].index, 10_001 - MAX_TASK_TIMELINE_EVENTS);
    assert.equal(history.events.at(-1)!.index, 10_000);
    assert.equal(history.latest_cycle, 1);
    assert.equal(history.truncated, true);
    assert.ok(history.events.every(event => event.details_truncated && event.details_json.length <= MAX_TASK_TIMELINE_DETAILS_CHARS));
    assert.equal(source.timeline[0].details, details);
    assert.equal(details.payload.length, 1_000_000);
    const html = renderTimeline(history);
    assert.equal((html.match(/class="task-timeline-event"/gu) || []).length, MAX_TASK_TIMELINE_EVENTS);
    assert.ok(html.length < MAX_TASK_TIMELINE_EVENTS * (MAX_TASK_TIMELINE_DETAILS_CHARS * 12 + 4096));
    assert.match(html, /The summary is bounded/u);
});

test('review attempt counters remain bounded for arbitrary custom review types', () => {
    const history = buildReportTaskTimeline(summary([{ event_type: 'TASK_MODE_ENTERED' },
        ...Array.from({ length: 100 }, (_, index) => ({ event_type: 'REVIEWER_DELEGATION_STARTED', details: { review_type: 'custom-' + index } }))]));
    assert.ok(history.events.some(event => event.review_attempt === null));
    assert.equal(history.truncated, true);
    assert.ok(history.diagnostics.some(message => message.includes('Review attempt numbering is bounded')));
});

test('every installed language localizes timeline controls while event descriptions and original data stay unchanged', () => {
    const history = buildReportTaskTimeline(summary([{ event_type: 'TASK_MODE_ENTERED' },
        { event_type: 'COMPILE_GATE_PASSED', outcome: 'PASS', message: 'Исходный текст', details: { command: 'node original-command' } }]));
    for (const language of LOCAL_UI_LANGUAGES) {
        const html = renderTimeline(history, language.id);
        assert.ok(html.includes(LOCAL_UI_TEXT[language.id].gateTimeline));
        assert.ok(html.includes(LOCAL_UI_TEXT[language.id].preview));
        assert.ok(html.includes(LOCAL_UI_TEXT[language.id].taskCommandEvents));
        assert.match(html, /Compilation passed\./u);
        assert.match(html, /COMPILE_GATE_PASSED/u);
        assert.match(html, /Исходный текст/u);
        assert.match(html, /node original-command/u);
    }
});

test('missing or foreign-task histories are unavailable and cannot expose foreign events or links', () => {
    const history = buildReportTaskTimeline(summary([{ event_type: 'TASK_MODE_ENTERED', message: 'Foreign text' }]));
    for (const value of [undefined, null, { ...history, task_id: 'T-101' }]) {
        const html = renderTimeline(value, 'ru');
        assert.ok(html.includes(LOCAL_UI_TASK_PROGRESS_TEXT.ru.unavailable));
        assert.doesNotMatch(html, /Foreign text|href=|task-timeline-event/u);
    }
});

test('client rendering independently caps event count, details and malformed scalar metadata', () => {
    const history: ReportTaskTimeline = buildReportTaskTimeline(summary([{ event_type: 'TASK_MODE_ENTERED' }]));
    const events = Array.from({ length: MAX_TASK_TIMELINE_EVENTS + 5 }, (_, index) => ({ ...history.events[0], index,
        details_json: '<'.repeat(MAX_TASK_TIMELINE_DETAILS_CHARS * 2), description: 'x'.repeat(10_000) }));
    const html = renderTimeline({ ...history, events, total_events: { huge: 'z'.repeat(1_000_000) }, latest_cycle: {}, omitted_events: [] });
    assert.equal((html.match(/class="task-timeline-event"/gu) || []).length, MAX_TASK_TIMELINE_EVENTS);
    assert.doesNotMatch(html, /z{1000}/u);
    assert.match(html, /The summary is bounded/u);
    assert.ok(html.length < MAX_TASK_TIMELINE_EVENTS * (MAX_TASK_TIMELINE_DETAILS_CHARS * 12 + 4096));
});
