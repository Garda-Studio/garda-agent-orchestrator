import { writeRuleRefreshReportFile, replacedRulesDirectory } from '../lifecycle/update/rule-refresh-report-store';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { bindContainedDestination, writeContainedFile } from '../core/contained-filesystem';
import { MIXED_RULE_FILES, refreshMixedRule } from './rule-refresh';

export interface RuleRefreshEntry { ruleFile: string; backupPath?: string; warning?: string }
export function ruleRefreshReportLines(entries: readonly RuleRefreshEntry[]): string[] {
    return ['## Installed Rule Refresh', ...entries.flatMap(entry => [
        ...(entry.backupPath ? [`- ${entry.ruleFile}: prior live copy saved to \`${entry.backupPath}\`.`] : []),
        ...(entry.warning ? [`- Warning: ${entry.warning}`] : [])
    ])];
}
export function newRuleRefreshId(): string { return new Date().toISOString().replace(/[:.]/gu, '-') + '-' + randomUUID(); }

export function writeRefreshedRule(options: {
    targetRoot: string; bundleRoot: string; livePath: string; ruleFile: string;
    content: string | Buffer; refreshId: string; dryRun: boolean; warning?: string | null;
}): RuleRefreshEntry {
    const entry: RuleRefreshEntry = { ruleFile: options.ruleFile, ...(options.warning ? { warning: options.warning } : {}) };
    if (options.dryRun || (options.warning && fs.existsSync(options.livePath))) return entry;
    const bytes = Buffer.isBuffer(options.content) ? options.content : Buffer.from(options.content, 'utf8');
    bindContainedDestination(options.targetRoot, options.livePath);
    if (fs.existsSync(options.livePath)) {
        const before = fs.readFileSync(options.livePath);
        if (before.equals(bytes)) return entry;
        const backup = path.join(replacedRulesDirectory(options.bundleRoot, options.refreshId), options.ruleFile);
        writeRuleRefreshReportFile(options.targetRoot, backup, before);
        entry.backupPath = path.relative(options.targetRoot, backup).replace(/\\/gu, '/');
    }
    writeContainedFile(options.targetRoot, options.livePath, bytes);
    return entry;
}

export function collectRuleRefreshWarnings(bundleRoot: string): string[] {
    const warnings: string[] = [];
    for (const file of MIXED_RULE_FILES) {
        const live = path.join(bundleRoot, 'live/docs/agent-rules', file);
        const template = path.join(bundleRoot, 'template/docs/agent-rules', file);
        if (!fs.existsSync(live) || !fs.existsSync(template)) continue;
        try {
            const result = refreshMixedRule(fs.readFileSync(live), fs.readFileSync(template, 'utf8'), file);
            if (result.warning) warnings.push(result.warning);
        } catch (error) {
            warnings.push(`${file} preserved: unrecognized or unreadable rule structure (${error instanceof Error ? error.message : String(error)}).`);
        }
    }
    return warnings;
}

export function writeRuleRefreshReport(targetRoot: string, bundleRoot: string, refreshId: string, entries: readonly RuleRefreshEntry[]): void {
    if (!entries.some(entry => entry.backupPath || entry.warning)) return;
    writeRuleRefreshReportFile(targetRoot, path.join(bundleRoot, 'runtime/update-reports', `rule-refresh-${refreshId}.md`), ruleRefreshReportLines(entries).join('\n') + '\n');
}
