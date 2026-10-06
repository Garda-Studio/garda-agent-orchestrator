import { MAX_TASK_TIMELINE_DETAILS_CHARS, MAX_TASK_TIMELINE_EVENTS } from '../../report-data/task-timeline';

/** Browser-side presentation of the bounded canonical task-event projection. */
export const UI_DASHBOARD_CLIENT_TASK_TIMELINE = `function taskTimelineText(value, limit) {
  return typeof value === 'string' ? value.slice(0, limit || 512) : '';
}
function taskTimelineEventModel(event) {
  const value = event && typeof event === 'object' ? event : {};
  return {
    index: Number.isSafeInteger(value.index) && value.index >= 0 ? value.index : null,
    timestamp_utc: taskTimelineText(value.timestamp_utc, 128) || null,
    event_type: taskTimelineText(value.event_type, 128) || 'UNKNOWN',
    outcome: taskTimelineText(value.outcome, 64) || 'UNKNOWN',
    cycle: Number.isSafeInteger(value.cycle) && value.cycle >= 0 ? value.cycle : 0,
    description: taskTimelineText(value.description) || 'Recorded event; no description is available for this event type.',
    review_type: taskTimelineText(value.review_type, 64) || null,
    review_attempt: Number.isSafeInteger(value.review_attempt) && value.review_attempt > 0 ? value.review_attempt : null,
    details_json: taskTimelineText(value.details_json, ${MAX_TASK_TIMELINE_DETAILS_CHARS}) || 'null',
    details_truncated: value.details_truncated === true || (typeof value.details_json === 'string' && value.details_json.length > ${MAX_TASK_TIMELINE_DETAILS_CHARS})
  };
}
function taskTimelineEntry(event) {
  const timestamp = event.timestamp_utc;
  const validTime = timestamp && Number.isFinite(Date.parse(timestamp));
  const time = validTime ? '<time datetime="' + safe(timestamp) + '">' + safe(timestamp) + '</time>'
    : '<span>Recorded time unavailable' + (timestamp ? ': <code>' + safe(timestamp) + '</code>' : '') + '</span>';
  return '<li class="task-timeline-event">' + time + ' <code>#' + safe(event.index === null ? '?' : event.index) + '</code>'
    + '<p>' + safe(event.description) + '</p>'
    + '<p><code>' + safe(event.event_type) + '</code> · <code>' + safe(event.outcome) + '</code>'
    + (event.review_type ? ' · ' + safe(event.review_type) + ' review' + (event.review_attempt ? ' · attempt ' + safe(event.review_attempt) : '') : '') + '</p>'
    + '<details><summary>' + safe(t('preview')) + ' · JSON</summary><pre>' + safe(event.details_json) + '</pre>'
    + (event.details_truncated ? '<p class="empty">' + safe(taskProgressText('summaryTruncated')) + '</p>' : '') + '</details></li>';
}
function taskTimeline(detail) {
  const history = detail.timeline;
  const valid = history && history.task_id === detail.task_id && Array.isArray(history.events);
  const title = '<h3 class="task-section-title">' + safe(t('gateTimeline')) + '</h3><p class="empty">' + safe(t('taskCommandEventsDescription')) + '</p>';
  if (!valid) return title + '<p class="empty">' + safe(taskProgressText('unavailable')) + '</p>';
  const events = history.events.slice(-${MAX_TASK_TIMELINE_EVENTS}).map(taskTimelineEventModel);
  const diagnostics = Array.isArray(history.diagnostics) ? history.diagnostics.slice(0, 8).map(item => taskTimelineText(item)) : [];
  const sourcePath = taskTimelineText(history.source_path, 2048);
  const latestCycleJson = taskTimelineText(history.latest_cycle_json, ${MAX_TASK_TIMELINE_DETAILS_CHARS});
  let previousCycle = null;
  const rows = events.map(event => {
    let heading = '';
    if (event.cycle !== previousCycle) {
      heading = '<li class="task-timeline-cycle"><strong>' + (event.cycle === 0 ? 'Cycle boundary unavailable'
        : 'Recorded cycle ' + safe(event.cycle) + (event.cycle === history.latest_cycle ? ' · latest' : ' · earlier')) + '</strong></li>';
      previousCycle = event.cycle;
    }
    return heading + taskTimelineEntry(event);
  }).join('');
  const latestCycleTruncated = history.latest_cycle_json_truncated === true
    || (typeof history.latest_cycle_json === 'string' && history.latest_cycle_json.length > ${MAX_TASK_TIMELINE_DETAILS_CHARS});
  const bounded = history.truncated === true || history.events.length > ${MAX_TASK_TIMELINE_EVENTS}
    || latestCycleTruncated || events.some(event => event.details_truncated);
  const raw = { task_id: taskTimelineText(detail.task_id, 64), source_path: sourcePath,
    total_events: Number.isSafeInteger(history.total_events) && history.total_events >= 0 ? history.total_events : null,
    latest_cycle: Number.isSafeInteger(history.latest_cycle) && history.latest_cycle >= 0 ? history.latest_cycle : null,
    omitted_events: Number.isSafeInteger(history.omitted_events) && history.omitted_events >= 0 ? history.omitted_events : null, truncated: bounded,
    incomplete: history.incomplete === true, diagnostics, events };
  return title + (bounded ? '<p class="empty">' + safe(taskProgressText('summaryTruncated')) + '</p>' : '')
    + (history.incomplete === true ? '<p class="empty">' + safe(taskProgressText('incomplete')) + '</p>' : '')
    + (diagnostics.length ? '<ul class="list">' + diagnostics.map(item => '<li>' + safe(item) + '</li>').join('') + '</ul>' : '')
    + (events.length ? '<ol class="list task-timeline">' + rows + '</ol>' : '<p class="empty">' + safe(t('events')) + ': 0</p>')
    + (sourcePath ? '<p><a href="/files?path=' + encodeURIComponent(sourcePath) + '&action_token=' + encodeURIComponent(actionToken) + '">' + safe(t('taskCommandEvents')) + '</a> <code>' + safe(sourcePath) + '</code></p>' : '')
    + (latestCycleJson ? '<details><summary>' + safe(t('gateTimeline')) + ' · JSON</summary><pre>' + safe(latestCycleJson) + '</pre>'
      + (latestCycleTruncated ? '<p class="empty">' + safe(taskProgressText('summaryTruncated')) + '</p>' : '') + '</details>' : '')
    + '<details><summary>' + safe(t('taskCommandEvents')) + ' · JSON</summary><pre>' + safe(JSON.stringify(raw, null, 2)) + '</pre></details>';
}
`;
