import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vm from 'node:vm';
import { buildDefaultWorkflowConfig } from '../../../src/core/workflow-config';
import { buildStaticHtmlReport, renderStaticHtmlReport } from '../../../src/reports/static-html-report';
import { buildReportDataContract } from '../../../src/reports/report-data-contract';
import { STATIC_HTML_TASK_CLIENT_SCRIPT } from '../../../src/reports/static-html/tasks-tab';

test('static task metrics treat labels and report values as text', () => {
    const context = vm.createContext({
        document: { querySelectorAll: () => [] },
        report: { tasks_tab: { rows: [] } }
    });
    vm.runInContext(STATIC_HTML_TASK_CLIENT_SCRIPT, context);
    const hostile = '<img src="x" onerror=\'bad\'>&';
    context.label = hostile;
    context.value = hostile;
    const html = vm.runInContext('metric(label, value)', context) as string;
    assert.equal(html, '<div class="metric"><span>&lt;img src=&quot;x&quot; onerror=&#39;bad&#39;&gt;&amp;</span><strong>&lt;img src=&quot;x&quot; onerror=&#39;bad&#39;&gt;&amp;</strong></div>');
    assert.equal(vm.runInContext('metric("Events", 3)', context), '<div class="metric"><span>Events</span><strong>3</strong></div>');
    assert.equal(vm.runInContext('metric("Events", null)', context), '<div class="metric"><span>Events</span><strong>-</strong></div>');
});

type StaticFakeListener = (event?: { key?: string }) => void;

class StaticFakeClassList {
    private readonly classes = new Set<string>();

    add(className: string): void {
        this.classes.add(className);
    }

    remove(className: string): void {
        this.classes.delete(className);
    }

    toggle(className: string, force?: boolean): void {
        if (force === true) {
            this.classes.add(className);
            return;
        }
        if (force === false) {
            this.classes.delete(className);
            return;
        }
        if (this.classes.has(className)) {
            this.classes.delete(className);
            return;
        }
        this.classes.add(className);
    }
}

class StaticFakeElement {
    readonly dataset: Record<string, string> = {};
    readonly classList = new StaticFakeClassList();
    readonly listeners = new Map<string, StaticFakeListener[]>();
    textContent = '';
    innerHTML = '';
    hidden = false;

    constructor(readonly id: string) {}

    addEventListener(eventName: string, listener: StaticFakeListener): void {
        const listeners = this.listeners.get(eventName) || [];
        listeners.push(listener);
        this.listeners.set(eventName, listeners);
    }

    dispatch(eventName: string, event?: { key?: string }): void {
        for (const listener of this.listeners.get(eventName) || []) {
            listener(event);
        }
    }

    setAttribute(name: string, value: string): void {
        if (name === 'aria-selected') {
            this.dataset.ariaSelected = value;
        }
    }

    replaceChildren(node: StaticFakeFragment): void {
        this.innerHTML = node.render();
    }
}

class StaticFakeFragment {
    private readonly elements = new Map<string, StaticFakeElement>();

    querySelector(selector: string): StaticFakeElement {
        if (!this.elements.has(selector)) {
            this.elements.set(selector, new StaticFakeElement(selector));
        }
        return this.elements.get(selector) as StaticFakeElement;
    }

    render(): string {
        return Array.from(this.elements.values())
            .map((element) => `${element.textContent}${element.innerHTML}`)
            .join('');
    }
}

class StaticFakeTemplate extends StaticFakeElement {
    readonly content = {
        cloneNode: () => new StaticFakeFragment()
    };
}

function extractStaticScript(html: string): string {
    const match = html.match(/<script>\n([\s\S]*)\n<\/script>\n<\/body>/u);
    assert.ok(match, 'expected static inline script');
    return match[1];
}

function extractReportDataJson(html: string): string {
    const match = html.match(/<script id="report-data" type="application\/json">([\s\S]*?)<\/script>/u);
    assert.ok(match, 'expected embedded report data');
    return match[1];
}

function stripEmbeddedReportData(html: string): string {
    return html.replace(/<script id="report-data" type="application\/json">[\s\S]*?<\/script>/u, '');
}

function extractStaticPanelHtml(html: string, panelId: string): string {
    const start = html.indexOf(`id="${panelId}"`);
    assert.notEqual(start, -1, `expected static panel ${panelId}`);
    const sectionStart = html.lastIndexOf('<section', start);
    const sectionEnd = html.indexOf('</section>', start);
    assert.notEqual(sectionStart, -1, `expected static panel section ${panelId}`);
    assert.notEqual(sectionEnd, -1, `expected static panel close ${panelId}`);
    return html.slice(sectionStart, sectionEnd);
}

function executeStaticTaskClient(html: string): StaticFakeElement {
    const detailElement = new StaticFakeElement('task-detail');
    const reportDataElement = new StaticFakeElement('report-data');
    reportDataElement.textContent = extractReportDataJson(html);
    const rows = [0, 1].map((index) => {
        const row = new StaticFakeElement(`row-${index}`);
        row.dataset.taskIndex = String(index);
        return row;
    });
    const elements: Record<string, StaticFakeElement> = {
        'report-data': reportDataElement,
        'task-detail': detailElement,
        'task-detail-template': new StaticFakeTemplate('task-detail-template'),
        'tab-tasks': new StaticFakeElement('tab-tasks'),
        'tab-quality-gate': new StaticFakeElement('tab-quality-gate'),
        'tab-workflow': new StaticFakeElement('tab-workflow'),
        'tab-init-settings': new StaticFakeElement('tab-init-settings'),
        'tab-project-memory': new StaticFakeElement('tab-project-memory'),
        'tab-backups': new StaticFakeElement('tab-backups'),
        'tab-instructions': new StaticFakeElement('tab-instructions')
    };
    elements['tab-tasks'].classList.add('active');
    elements['tab-quality-gate'].hidden = true;
    elements['tab-workflow'].hidden = true;
    elements['tab-init-settings'].hidden = true;
    elements['tab-project-memory'].hidden = true;
    elements['tab-backups'].hidden = true;
    elements['tab-instructions'].hidden = true;
    const tabs = ['tasks', 'quality-gate', 'workflow', 'init-settings', 'project-memory', 'backups', 'instructions'].map((tabId) => {
        const tab = new StaticFakeElement(`tab-button-${tabId}`);
        tab.dataset.tab = tabId;
        return tab;
    });
    vm.runInNewContext(extractStaticScript(html), {
        document: {
            getElementById: (id: string) => elements[id] || new StaticFakeElement(id),
            querySelectorAll: (selector: string) => {
                if (selector === '.tab') {
                    return tabs;
                }
                if (selector === '.panel') {
                    return Object.values(elements).filter((element) => element.id.startsWith('tab-'));
                }
                if (selector === 'tr[data-task-index]') {
                    return rows;
                }
                return [];
            }
        },
        JSON,
        Number,
        String,
        encodeURI
    });
    rows[0].dispatch('click');
    tabs[1].dispatch('click');
    assert.equal(elements['tab-quality-gate'].hidden, false);
    assert.equal(elements['tab-tasks'].hidden, true);
    return detailElement;
}

function makeTempRepo(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'garda-static-html-report-'));
}

function writeTaskMd(repoRoot: string): void {
    fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
        '# TASK.md',
        '',
        '## Active Queue',
        '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
        '|---|---|---|---|---|---|---|---|---|',
        '| T-100 | IN_PROGRESS | P2 | ui/report | Build <HTML> report | gpt-5.4 | 2026-05-16 | balanced | Uses logs only |',
        '| T-101 | TODO | P2 | ui/report | Next report task | gpt-5.4 | 2026-05-16 | balanced | Next task |',
        '',
        '## User Summary (RU)',
        '| ID | Summary |',
        '|---|---|',
        '| T-999 | Must stay out of the upper queue |'
    ].join('\n'));
}

function writeWorkflowConfig(repoRoot: string): void {
    const configPath = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(buildDefaultWorkflowConfig(), null, 2));
}

function writeInitAnswers(repoRoot: string): void {
    fs.writeFileSync(path.join(repoRoot, 'AGENTS.md'), '# Agent instructions\n');
    const initAnswersPath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'init-answers.json');
    fs.mkdirSync(path.dirname(initAnswersPath), { recursive: true });
    fs.writeFileSync(initAnswersPath, JSON.stringify({ SourceOfTruth: 'Codex' }, null, 2));
}

function writeProjectMemoryReadme(repoRoot: string): void {
    const memoryPath = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'docs', 'project-memory', 'README.md');
    fs.mkdirSync(path.dirname(memoryPath), { recursive: true });
    fs.writeFileSync(memoryPath, '# Project memory\n');
    const promptPath = path.join(repoRoot, 'garda-agent-orchestrator', 'template', 'docs', 'prompts', 'project-memory-optimization.md');
    fs.mkdirSync(path.dirname(promptPath), { recursive: true });
    fs.writeFileSync(promptPath, '# Project memory optimization prompt\n');
}

test('renderStaticHtmlReport includes tabs, escaped task rows, and embedded data', () => {
    const repoRoot = makeTempRepo();
    writeTaskMd(repoRoot);
    writeWorkflowConfig(repoRoot);
    writeInitAnswers(repoRoot);
    writeProjectMemoryReadme(repoRoot);

    const report = buildReportDataContract({ repoRoot, generatedAtUtc: '2026-05-16T00:00:00.000Z' });
    const longQualityRuleId = 'baseline_quality_rule_with_long_unbroken_identifier_for_static_wrap_0123456789';
    const longQualityRuleTitle = 'StaticLongUnbrokenQualityGateRuleTitleThatMustNotForceTheReportWiderThanTheViewport';
    const longQualityRulePrompt = 'StaticLongUnbrokenQualityGateRulePromptThatExercisesOverflowWrappingInTheQualityRulesTable';
    report.quality_gate_tab.rules.unshift({
        id: longQualityRuleId,
        title: longQualityRuleTitle,
        prompt: longQualityRulePrompt,
        baseline_title: longQualityRuleTitle,
        baseline_prompt: longQualityRulePrompt,
        excluded_scope_categories: [],
        baseline_excluded_scope_categories: [],
        enabled: false,
        present: true,
        source: 'baseline',
        statuses: ['disabled']
    });
    report.quality_gate_tab.baseline_rule_count += 1;
    report.tasks_tab.rows[0].detail.artifact_links = [{
        kind: 'compile-output',
        path: 'C:/repo/garda-agent-orchestrator/runtime/reviews/T-100-compile-output.log',
        exists: true,
        sha256: 'abc123'
    }, {
        kind: 'quality-checklist',
        path: 'C:/repo/garda-agent-orchestrator/runtime/reviews/T-100-quality-checklist.json',
        exists: true,
        sha256: 'quality123'
    }];
    report.tasks_tab.rows[0].detail.quality_checklist = {
        latest: {
            artifact_path: 'C:/repo/garda-agent-orchestrator/runtime/reviews/T-100-quality-checklist.json',
            artifact_exists: true,
            artifact_sha256: 'quality123',
            evidence_status: 'current',
            checklist_status: 'ACTION_REQUIRED',
            outcome: 'FAIL',
            effect: 'required_rework',
            summary: 'Quality checklist required rework (1 action item).',
            stale_reasons: [],
            timestamp_utc: '2026-05-16T00:02:00.000Z',
            changed_files_count: 1,
            changed_files_preview: ['src/reports/static-html/tasks-tab.ts'],
            answer_count: 1,
            action_taken_count: 0,
            action_required_count: 1,
            actions_taken: [],
            actions_required: ['Keep quality details in task history.'],
            answers: [{
                rule_id: 'artifact_evidence_binding',
                status: 'WARN',
                answer: 'Task detail keeps quality checklist evidence reachable.',
                evidence_files: ['src/reports/static-html/tasks-tab.ts'],
                actions_taken: [],
                actions_required: ['Keep quality details in task history.']
            }]
        },
        action_required_history: [{
            task_id: 'T-100',
            timestamp_utc: '2026-05-16T00:02:00.000Z',
            artifact_path: 'C:/repo/garda-agent-orchestrator/runtime/reviews/T-100-quality-checklist.json',
            evidence_status: 'current',
            action_required_count: 1,
            actions_required: ['Keep quality details in task history.'],
            changed_files_count: 1,
            changed_files_preview: ['src/reports/static-html/tasks-tab.ts']
        }]
    };
    report.tasks_tab.rows[0].detail.full_suite_validation = {
        ...report.tasks_tab.rows[0].detail.full_suite_validation,
        state: 'passed',
        freshness: 'current',
        enabled: true,
        required: true,
        status: 'PASSED',
        command: 'npm test',
        duration_ms: 123456,
        duration_human: '2m 3.5s',
        timed_out: false,
        exit_code: 0,
        timeout_blocker: true,
        timeout_retry_count: 1,
        timeout_max_attempts: 2,
        timeout_attempts: [{ attempt: 1, exit_code: null, timed_out: true }],
        timeout_attempts_exhausted: false,
        timeout_warning_only_continuation: false,
        timeout_repair_task_proposal: {
            suggested_task_id: 'T-100-F1',
            title: 'Fix timed-out full-suite validation',
            area: 'tests',
            rationale: 'Full-suite timed out before terminal evidence.'
        },
        artifact_path: 'C:/repo/garda-agent-orchestrator/runtime/reviews/T-100-full-suite-validation.json',
        artifact_exists: true,
        output_artifact_path: 'C:/repo/garda-agent-orchestrator/runtime/reviews/T-100-full-suite-output.log',
        compact_summary: ['# tests 10'],
        warnings: ['full-suite timeout warning is visible in static task detail'],
        timeout_forecast: {
            history_path: 'runtime/metrics/full-suite-validation-duration-history.json',
            sample_count: 5,
            excluded_sample_count: 1,
            excluded_sample_reasons: { timed_out: 1 },
            average_duration_seconds: 343.2,
            high_watermark_duration_seconds: 396.3,
            recommended_timeout_seconds: 476,
            safety_margin_seconds: 79.7,
            recommendation_source: 'history',
            configured_timeout_seconds: 600,
            warning: null
        },
        timeout_forecast_label: 'Recommended full-suite command timeout: 476s (target sample 5 recent run(s); eligible 5 run(s) avg 343.2s; max 396.3s; safety margin over max +79.7s = 20% but at least 30s).'
    };
    const html = renderStaticHtmlReport(report);

    assert.ok(html.includes('data-tab="tasks"'));
    assert.ok(html.includes('data-tab="quality-gate"'));
    assert.ok(html.includes('data-tab="workflow"'));
    assert.ok(html.includes('data-tab="init-settings"'));
    assert.ok(html.includes('data-tab="project-memory"'));
    assert.ok(html.includes('data-tab="backups"'));
    assert.ok(html.includes('data-tab="instructions"'));
    assert.ok(html.includes('id="tab-init-settings"'));
    assert.ok(html.includes('id="tab-quality-gate"'));
    assert.ok(html.includes('id="tab-project-memory"'));
    assert.ok(html.includes('id="tab-backups"'));
    assert.ok(html.includes('read-only in static HTML'));
    assert.ok(!html.includes('data-tab="actions"'));
    assert.ok(html.includes('Build &lt;HTML&gt; report'));
    assert.ok(html.includes('toArtifactHref(item.path)'));
    assert.ok(html.includes('<a href="'));
    assert.ok(html.includes('href="../../../AGENTS.md"'));
    assert.ok(html.includes('href="../../live/docs/project-memory/README.md"'));
    assert.ok(html.includes('Project Memory Optimization'));
    assert.ok(html.includes('Quality Gate'));
    assert.ok(html.includes('th, td, td code { overflow-wrap: anywhere; }'));
    assert.ok(!html.includes('Shipped baseline'));
    const visibleHtml = stripEmbeddedReportData(html);
    const visibleQualityGatePanelHtml = extractStaticPanelHtml(visibleHtml, 'tab-quality-gate');
    assert.ok(!visibleQualityGatePanelHtml.includes('Path:'));
    assert.ok(!/\d{4}-\d{2}-\d{2}\.t\d+/u.test(visibleQualityGatePanelHtml));
    assert.ok(visibleQualityGatePanelHtml.includes('Installed rule pack'));
    assert.ok(visibleQualityGatePanelHtml.includes('Shipped rule pack'));
    assert.ok(visibleHtml.includes(longQualityRuleId));
    assert.ok(visibleHtml.includes(longQualityRuleTitle));
    assert.ok(visibleHtml.includes(longQualityRulePrompt));
    assert.ok(!visibleQualityGatePanelHtml.includes('Latest check'));
    assert.ok(!visibleQualityGatePanelHtml.includes('Skipped by scope'));
    assert.ok(visibleQualityGatePanelHtml.includes('Excluded scopes'));
    assert.ok(!visibleQualityGatePanelHtml.includes('Action-required history'));
    report.quality_gate_tab.latest_check = {
        ...report.quality_gate_tab.latest_check,
        answers: [{
            rule_id: 'ui_answer_visibility',
            status: 'WARN',
            answer: 'Renderer must show compact rule answer details.',
            evidence_files: ['src/reports/static-html/quality-gate-tab.ts'],
            actions_taken: ['Rendered answer summary in static HTML.'],
            actions_required: ['Keep UI and static renderers in parity.']
        }]
    };
    const answerSummaryHtml = renderStaticHtmlReport(report);
    const answerSummaryVisibleHtml = stripEmbeddedReportData(answerSummaryHtml);

    assert.ok(answerSummaryHtml.includes('ui_answer_visibility'));
    assert.ok(!answerSummaryVisibleHtml.includes('Renderer must show compact rule answer details.'));
    assert.ok(!answerSummaryVisibleHtml.includes('src/reports/static-html/quality-gate-tab.ts'));
    assert.ok(!answerSummaryVisibleHtml.includes('Rendered answer summary in static HTML.'));
    assert.ok(!answerSummaryVisibleHtml.includes('Keep UI and static renderers in parity.'));
    assert.ok(answerSummaryHtml.includes('garda-agent-orchestrator/template/docs/prompts/project-memory-optimization.md'));
    assert.ok(answerSummaryHtml.includes('href="../../template/docs/prompts/project-memory-optimization.md"'));
    assert.ok(!answerSummaryHtml.includes('href="AGENTS.md"'));
    assert.ok(answerSummaryHtml.includes('C:/repo/garda-agent-orchestrator/runtime/reviews/T-100-compile-output.log'));
    assert.ok(answerSummaryHtml.includes('Full-suite Validation'));
    assert.ok(answerSummaryHtml.includes('T-100-full-suite-validation.json'));
    assert.ok(answerSummaryHtml.includes('2m 3.5s'));
    assert.ok(answerSummaryHtml.includes('Average duration'));
    assert.ok(answerSummaryHtml.includes('Recommended timeout'));
    assert.ok(answerSummaryHtml.includes('Timeout blocks task'));
    assert.ok(answerSummaryHtml.includes('Forecast excluded samples'));
    assert.ok(answerSummaryHtml.includes('fullSuiteDurationSeconds(forecast.average_duration_seconds)'));
    assert.ok(answerSummaryHtml.includes('"average_duration_seconds":343.2'));
    assert.ok(answerSummaryHtml.includes('"recommended_timeout_seconds":476'));
    assert.ok(answerSummaryHtml.includes('"task_id":"T-100"'));
    assert.ok(!answerSummaryHtml.includes('Must stay out of the upper queue'));
    const answerRenderedDetail = executeStaticTaskClient(answerSummaryHtml);

    assert.ok(answerRenderedDetail.innerHTML.includes('<th>Configured timeout</th><td>10m</td>'));
    assert.ok(answerRenderedDetail.innerHTML.includes('<th>Average duration</th><td>5m 43.2s</td>'));
    assert.ok(answerRenderedDetail.innerHTML.includes('<th>High-watermark duration</th><td>6m 36.3s</td>'));
    assert.ok(answerRenderedDetail.innerHTML.includes('<th>Recommended timeout</th><td>7m 56s</td>'));
    assert.ok(answerRenderedDetail.innerHTML.includes('<th>Timeout blocks task</th><td>true</td>'));
    assert.ok(answerRenderedDetail.innerHTML.includes('<th>Timeout attempts</th><td>#1 timed out</td>'));
    assert.ok(answerRenderedDetail.innerHTML.includes('<th>Timeout repair task proposal</th><td>T-100-F1 - Fix timed-out full-suite validation</td>'));
    assert.ok(answerRenderedDetail.innerHTML.includes('<th>Forecast excluded samples</th><td>1</td>'));
    assert.ok(answerRenderedDetail.innerHTML.includes('<th>Forecast exclusion reasons</th><td>timed-out runs=1</td>'));
    assert.ok(answerRenderedDetail.innerHTML.includes('full-suite timeout warning is visible in static task detail'));
    assert.ok(answerRenderedDetail.innerHTML.includes('Quality checklist required rework (1 action item).'));
    assert.ok(answerRenderedDetail.innerHTML.includes('Required rework'));
    assert.ok(!answerRenderedDetail.innerHTML.includes('required_rework'));
    assert.ok(answerRenderedDetail.innerHTML.includes('Keep quality details in task history.'));
    assert.ok(answerRenderedDetail.innerHTML.includes('artifact_evidence_binding'));
    assert.ok(answerRenderedDetail.innerHTML.includes('T-100-quality-checklist.json'));

    report.quality_gate_tab.latest_check = {
        ...report.quality_gate_tab.latest_check,
        answers: []
    };
    const renderedDetail = executeStaticTaskClient(html);

    assert.ok(renderedDetail.innerHTML.includes('<th>Configured timeout</th><td>10m</td>'));
    assert.ok(renderedDetail.innerHTML.includes('<th>Average duration</th><td>5m 43.2s</td>'));
    assert.ok(renderedDetail.innerHTML.includes('<th>High-watermark duration</th><td>6m 36.3s</td>'));
    assert.ok(renderedDetail.innerHTML.includes('<th>Recommended timeout</th><td>7m 56s</td>'));
    assert.ok(renderedDetail.innerHTML.includes('<th>Timeout blocks task</th><td>true</td>'));
    assert.ok(renderedDetail.innerHTML.includes('<th>Timeout attempts</th><td>#1 timed out</td>'));
    assert.ok(renderedDetail.innerHTML.includes('<th>Timeout repair task proposal</th><td>T-100-F1 - Fix timed-out full-suite validation</td>'));
    assert.ok(renderedDetail.innerHTML.includes('<th>Forecast excluded samples</th><td>1</td>'));
    assert.ok(renderedDetail.innerHTML.includes('<th>Forecast exclusion reasons</th><td>timed-out runs=1</td>'));
    assert.ok(renderedDetail.innerHTML.includes('full-suite timeout warning is visible in static task detail'));

    report.tasks_tab.rows[0].detail.full_suite_validation = {
        ...report.tasks_tab.rows[0].detail.full_suite_validation,
        timeout_forecast: {
            history_path: 'runtime/metrics/full-suite-validation-duration-history.json',
            sample_count: 0,
            excluded_sample_count: 0,
            excluded_sample_reasons: {},
            average_duration_seconds: null,
            high_watermark_duration_seconds: null,
            recommended_timeout_seconds: 600,
            safety_margin_seconds: null,
            recommendation_source: 'config_timeout',
            configured_timeout_seconds: 600,
            warning: null
        },
        timeout_forecast_label: 'Recommended full-suite command timeout: 600s (no recent matching full-suite duration history; using configured timeout).'
    };
    const noHistoryHtml = renderStaticHtmlReport(report);

    assert.ok(noHistoryHtml.includes('Configured timeout'));
    assert.ok(noHistoryHtml.includes('Average duration'));
    assert.ok(noHistoryHtml.includes('High-watermark duration'));
    assert.ok(noHistoryHtml.includes('Recommended timeout'));
    assert.ok(noHistoryHtml.includes('"average_duration_seconds":null'));
    assert.ok(noHistoryHtml.includes('"high_watermark_duration_seconds":null'));
    assert.ok(noHistoryHtml.includes('"recommendation_source":"config_timeout"'));
    assert.ok(noHistoryHtml.includes('"recommended_timeout_seconds":600'));
    const noHistoryRenderedDetail = executeStaticTaskClient(noHistoryHtml);

    assert.ok(noHistoryRenderedDetail.innerHTML.includes('<th>Configured timeout</th><td>10m</td>'));
    assert.ok(noHistoryRenderedDetail.innerHTML.includes('<th>Average duration</th><td>-</td>'));
    assert.ok(noHistoryRenderedDetail.innerHTML.includes('<th>High-watermark duration</th><td>-</td>'));
    assert.ok(noHistoryRenderedDetail.innerHTML.includes('<th>Recommended timeout</th><td>10m</td>'));

    report.quality_gate_tab.latest_check = {
        ...report.quality_gate_tab.latest_check,
        artifact_exists: true,
        evidence_status: 'invalid',
        effect: 'invalid',
        summary: 'Latest quality checklist artifact is invalid.',
        stale_reasons: ['Unsupported quality checklist status: BROKEN.']
    };
    const invalidQualityGateHtml = renderStaticHtmlReport(report);
    const invalidQualityGateVisibleHtml = stripEmbeddedReportData(invalidQualityGateHtml);

    assert.ok(invalidQualityGateHtml.includes('Latest quality checklist artifact is invalid.'));
    assert.ok(invalidQualityGateHtml.includes('Unsupported quality checklist status: BROKEN.'));
    assert.ok(!invalidQualityGateVisibleHtml.includes('Latest quality checklist artifact is invalid.'));
    assert.ok(!invalidQualityGateVisibleHtml.includes('Unsupported quality checklist status: BROKEN.'));
});

test('buildStaticHtmlReport writes default runtime report and returns a browser URL', () => {
    const repoRoot = makeTempRepo();
    writeTaskMd(repoRoot);
    writeWorkflowConfig(repoRoot);

    const result = buildStaticHtmlReport({
        repoRoot,
        generatedAtUtc: '2026-05-16T00:00:00.000Z'
    });

    assert.equal(result.task_count, 2);
    assert.equal(result.detailed_task_count, 0);
    assert.equal(result.skipped_detail_count, 2);
    assert.equal(result.max_detailed_tasks, 0);
    assert.match(result.url, /^file:\/\//);
    assert.ok(result.output_path.endsWith(path.join('garda-agent-orchestrator', 'runtime', 'reports', 'garda-report.html')));
    assert.ok(fs.existsSync(result.output_path));
    assert.match(fs.readFileSync(result.output_path, 'utf8'), /Garda HTML Report/);
});

test('buildStaticHtmlReport can skip deep task details for fast snapshots', () => {
    const repoRoot = makeTempRepo();
    writeTaskMd(repoRoot);
    writeWorkflowConfig(repoRoot);

    const result = buildStaticHtmlReport({
        repoRoot,
        generatedAtUtc: '2026-05-16T00:00:00.000Z',
        maxDetailedTasks: 0
    });

    assert.equal(result.task_count, 2);
    assert.equal(result.detailed_task_count, 0);
    assert.equal(result.skipped_detail_count, 2);
    assert.equal(result.max_detailed_tasks, 0);
    const html = fs.readFileSync(result.output_path, 'utf8');
    assert.ok(html.includes('Deep task details are lazy'));
    assert.ok(html.includes('<td>skipped</td>'));
});

test('buildStaticHtmlReport can write timestamped snapshots', () => {
    const repoRoot = makeTempRepo();
    writeTaskMd(repoRoot);
    writeWorkflowConfig(repoRoot);

    const result = buildStaticHtmlReport({
        repoRoot,
        generatedAtUtc: '2026-05-16T00:00:00.000Z',
        snapshot: true
    });

    assert.equal(result.latest_path, result.output_path);
    assert.equal(result.latest_url, result.url);
    assert.ok(result.snapshot_path?.endsWith(path.join('snapshots', 'garda-report-20260516T000000000Z.html')));
    assert.match(result.snapshot_url || '', /^file:\/\//);
    assert.ok(result.snapshot_path && fs.existsSync(result.snapshot_path));
});

test('buildStaticHtmlReport prunes old snapshots when retention is set', () => {
    const repoRoot = makeTempRepo();
    writeTaskMd(repoRoot);
    writeWorkflowConfig(repoRoot);

    buildStaticHtmlReport({
        repoRoot,
        generatedAtUtc: '2026-05-16T00:00:00.000Z',
        snapshot: true
    });
    buildStaticHtmlReport({
        repoRoot,
        generatedAtUtc: '2026-05-16T00:01:00.000Z',
        snapshot: true
    });
    const result = buildStaticHtmlReport({
        repoRoot,
        generatedAtUtc: '2026-05-16T00:02:00.000Z',
        snapshot: true,
        snapshotRetention: 2
    });

    assert.equal(result.deleted_snapshot_paths.length, 1);
    assert.ok(result.deleted_snapshot_paths[0].endsWith('garda-report-20260516T000000000Z.html'));
    const snapshotDir = path.dirname(result.snapshot_path || '');
    assert.deepEqual(fs.readdirSync(snapshotDir).sort(), [
        'garda-report-20260516T000100000Z.html',
        'garda-report-20260516T000200000Z.html'
    ]);
});
