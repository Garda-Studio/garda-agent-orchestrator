import { escapeHtml } from './common';
import type { ReportWorkflowConfigTab, ReportWorkflowSetting } from '../report-data-contract';

function renderWorkflowSetting(setting: ReportWorkflowSetting): string {
    const options = setting.options.length > 0
        ? setting.options.map((option) => `${option.label} (${option.value}): ${option.description}`).join('\n')
        : 'No fixed options';
    const readiness = setting.readiness
        ? `<br><strong>Readiness:</strong> ${escapeHtml(setting.readiness.ready ? 'ready' : 'not ready')}`
            + (setting.readiness.disabled_reason ? `<br><code>${escapeHtml(setting.readiness.disabled_reason)}</code>` : '')
            + (setting.readiness.remediation_command ? `<br><code>${escapeHtml(setting.readiness.remediation_command)}</code>` : '')
        : '';
    return [
        '<tr>',
        `<td><strong>${escapeHtml(setting.label)}</strong><br><code>(${escapeHtml(setting.key)})</code></td>`,
        `<td>${escapeHtml(JSON.stringify(setting.value))}</td>`,
        `<td>${escapeHtml(setting.description)}${readiness}<br><pre>${escapeHtml(options)}</pre></td>`,
        `<td><code>${escapeHtml(setting.command)}</code></td>`,
        '</tr>'
    ].join('');
}

export function renderWorkflowPanel(tab: ReportWorkflowConfigTab): string {
    return [
        '<section class="panel" id="tab-workflow" role="tabpanel">',
        '<div class="card">',
        '<h2>Workflow Config</h2>',
        tab.compact_cache ? `<p class="meta">Compact cache: ${tab.compact_cache.available ? `${tab.compact_cache.bytes} bytes; ${tab.compact_cache.runs} runs` : 'unavailable'}</p>` : '',
        `<p class="meta">Path: ${escapeHtml(tab.config_path)} | Status: ${escapeHtml(tab.status)}</p>`,
        '<div class="table-wrap" style="margin-top: 12px;">',
        '<table class="settings-table">',
        '<thead><tr><th>Setting</th><th>Value</th><th>Description</th><th>Command</th></tr></thead>',
        `<tbody>${tab.settings.map(renderWorkflowSetting).join('')}</tbody>`,
        '</table>',
        '</div>',
        '</div>',
        '</section>'
    ].join('');
}
