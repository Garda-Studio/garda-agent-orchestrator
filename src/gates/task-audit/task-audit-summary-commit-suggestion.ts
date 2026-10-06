import { getNodeGateCommandPrefix } from '../../materialization/command-constants';
import { toPosix } from '../shared/helpers';
import type { TaskQueueMetadata } from './task-audit-summary-collectors';

const MATERIALIZED_REVIEW_FOLLOW_UP_PROVENANCE_PATTERN =
    /(?:^|\s)review_follow_up_(?:group_)?fingerprint=[a-f0-9]{64}\.(?=$|\s)/u;

function normalizeCommitToken(value: string): string {
    return String(value || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

function normalizeCommitSubject(value: string): string {
    const normalized = String(value || '')
        .trim()
        .replace(/[_-]+/g, ' ')
        .replace(/\s+/g, ' ')
        .replace(/[.]+$/g, '')
        .replace(/"/g, '\'');
    if (!normalized) {
        return '<summary>';
    }
    return normalized.charAt(0).toLowerCase() + normalized.slice(1);
}

function hasMultipleCommitSubjectWords(subject: string): boolean {
    return String(subject || '')
        .trim()
        .split(/\s+/u)
        .filter(Boolean)
        .length >= 2;
}

function isLowQualityCommitSubject(subject: string, scope: string): boolean {
    if (subject === '<summary>') {
        return true;
    }
    if (!hasMultipleCommitSubjectWords(subject)) {
        return true;
    }
    return normalizeCommitToken(subject) === normalizeCommitToken(scope);
}

function inferCommitType(taskMetadata: TaskQueueMetadata | null): 'feat' | 'fix' {
    const text = `${taskMetadata?.area || ''} ${taskMetadata?.title || ''}`.toLowerCase();
    const featureKeywords = ['add', 'introduce', 'support', 'enable', 'create', 'implement', 'allow', 'reuse', 'automate', 'generate', 'install'];
    return featureKeywords.some((keyword) => new RegExp(`\\b${keyword}\\b`, 'i').test(text)) ? 'feat' : 'fix';
}

function inferCommitScope(changedFiles: string[], taskMetadata: TaskQueueMetadata | null): string {
    const scopeMatchers: Array<{ scope: string; patterns: RegExp[] }> = [
        {
            scope: 'orchestration',
            patterns: [
                /^src\/gates\//,
                /^src\/cli\/commands\/gate-/,
                /^template\/docs\/agent-rules\//,
                /^template\/skills\/orchestration\//,
                /^tests\/node\/gates\/task-audit-summary\.test\.ts$/,
                /^tests\/node\/validators\/verify\.test\.ts$/
            ]
        },
        { scope: 'runtime', patterns: [/^src\/gate-runtime\//] },
        { scope: 'validators', patterns: [/^src\/validators\//] },
        { scope: 'materialization', patterns: [/^src\/materialization\//] },
        { scope: 'setup', patterns: [/^src\/cli\/commands\/setup\.ts$/, /^src\/lifecycle\/setup/i] },
        { scope: 'update', patterns: [/^src\/lifecycle\/update\.ts$/, /^src\/lifecycle\/check-update/i] }
    ];
    const scopeScores = new Map<string, number>();
    const normalizedChangedFiles = [...new Set(changedFiles.map((changedFile) => toPosix(String(changedFile || ''))))]
        .sort((left, right) => left.localeCompare(right));
    for (const normalizedPath of normalizedChangedFiles) {
        for (const matcher of scopeMatchers) {
            if (matcher.patterns.some((pattern) => pattern.test(normalizedPath))) {
                scopeScores.set(matcher.scope, (scopeScores.get(matcher.scope) || 0) + 1);
            }
        }
    }

    let bestScope: string | null = null;
    let bestScore = -1;
    for (const [scope, score] of [...scopeScores.entries()].sort((left, right) => left[0].localeCompare(right[0]))) {
        if (score > bestScore || (score === bestScore && bestScope != null && scope.localeCompare(bestScope) < 0)) {
            bestScope = scope;
            bestScore = score;
        }
    }
    if (bestScope) {
        return bestScope;
    }

    const rawArea = String(taskMetadata?.area || '').trim();
    const [areaPrefix = ''] = rawArea.split('/');
    const normalizedAreaPrefix = normalizeCommitToken(areaPrefix);
    if (normalizedAreaPrefix && !['ux', 'reliability', 'performance', 'security', 'docs', 'feature', 'feat'].includes(normalizedAreaPrefix)) {
        return normalizedAreaPrefix;
    }

    return 'orchestration';
}

function inferCommitSubject(taskMetadata: TaskQueueMetadata | null, scope: string): string {
    const rawArea = String(taskMetadata?.area || '').trim();
    const areaSuffix = rawArea.includes('/') ? rawArea.split('/').pop() || '' : rawArea;
    const normalizedAreaSubject = normalizeCommitSubject(areaSuffix);
    const normalizedTitleSubject = normalizeCommitSubject(String(taskMetadata?.title || ''));
    const isMaterializedReviewFollowUp = MATERIALIZED_REVIEW_FOLLOW_UP_PROVENANCE_PATTERN
        .test(String(taskMetadata?.notes || ''));
    const candidates = isMaterializedReviewFollowUp
        ? [normalizedTitleSubject, normalizedAreaSubject]
        : [normalizedAreaSubject, normalizedTitleSubject];
    for (const candidate of candidates) {
        if (!isLowQualityCommitSubject(candidate, scope)) {
            return candidate;
        }
    }

    return '<summary>';
}

export function buildCommitCommandSuggestion(
    changedFiles: string[],
    taskMetadata: TaskQueueMetadata | null,
    commitGuardEnabled: boolean,
    localCommit?: { taskId: string }
): { template: string; suggestion: string } {
    const nativePrefix = localCommit
        ? `${getNodeGateCommandPrefix()} human-commit --task-id "${localCommit.taskId}"`
        : `${getNodeGateCommandPrefix()} human-commit --operator-confirmed yes`;
    const template = localCommit || commitGuardEnabled
        ? `${nativePrefix} --message "<type>(<scope>): <summary>"`
        : 'git commit -m "<type>(<scope>): <summary>"';
    const type = inferCommitType(taskMetadata);
    const scope = inferCommitScope(changedFiles, taskMetadata);
    const subject = inferCommitSubject(taskMetadata, scope);
    if (subject === '<summary>') {
        return { template, suggestion: template };
    }

    const message = `${type}(${scope}): ${subject}`;
    return {
        template,
        suggestion: localCommit || commitGuardEnabled
            ? `${nativePrefix} --message "${message}"`
            : `git commit -m "${message}"`
    };
}
