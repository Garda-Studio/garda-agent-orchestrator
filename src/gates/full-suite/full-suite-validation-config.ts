import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

import { redactSecretText } from '../../core/redaction';
import { FULL_SUITE_TIMEOUT_RETRY_COUNT_MAX } from '../../core/workflow-config';
import {
    DEFAULT_FULL_SUITE_VALIDATION_CONFIG
} from '../../core/full-suite-validation-config';
import { joinOrchestratorPath, normalizePath } from '../shared/helpers';
import {
    type FullSuiteDurationForecastExclusionReason,
    type FullSuiteDurationHistory,
    type FullSuiteDurationHistoryEntry,
    type FullSuiteDurationHistoryComparison,
    type FullSuitePerformanceGuidance,
    type FullSuiteTimeoutForecast,
    type FullSuiteValidationConfig
} from './full-suite-validation-types';
import { isPlainRecord } from '../../core/records';

export const FULL_SUITE_DURATION_HISTORY_LIMIT = 5;
export const FULL_SUITE_TIMEOUT_MARGIN_RATIO = 0.2;
export const FULL_SUITE_TIMEOUT_MIN_MARGIN_SECONDS = 30;
export const FULL_SUITE_DURATION_OUTLIER_MIN_MS = 6 * 60 * 60 * 1000;
export const FULL_SUITE_DURATION_OUTLIER_TIMEOUT_MULTIPLIER = 3;

const DEFAULT_CONFIG: FullSuiteValidationConfig = Object.freeze({
    ...DEFAULT_FULL_SUITE_VALIDATION_CONFIG
});

export {
    loadFullSuiteValidationConfig,
    resolveWorkflowConfigPath
} from '../../core/full-suite-validation-config';

export function resolveFullSuiteDurationHistoryPath(repoRoot: string): string {
    return joinOrchestratorPath(repoRoot, path.join('runtime', 'metrics', 'full-suite-validation-duration-history.json'));
}

export function buildFullSuiteConfigSignature(config: FullSuiteValidationConfig): string {
    const relevantConfig = {
        command: config.command,
        ...(config.report_files?.length ? { report_files: config.report_files } : {}),
        timeout_ms: config.timeout_ms,
        timeout_blocker: config.timeout_blocker !== false,
        timeout_retry_count: Number.isSafeInteger(config.timeout_retry_count) && (config.timeout_retry_count ?? 0) >= 0
            && (config.timeout_retry_count ?? 0) <= FULL_SUITE_TIMEOUT_RETRY_COUNT_MAX
            ? config.timeout_retry_count
            : DEFAULT_CONFIG.timeout_retry_count,
        green_summary_max_lines: config.green_summary_max_lines,
        red_failure_chunk_lines: config.red_failure_chunk_lines,
        out_of_scope_failure_policy: config.out_of_scope_failure_policy,
        placement: config.placement
    };
    return createHash('sha256').update(JSON.stringify(relevantConfig)).digest('hex');
}

function isFullSuiteDurationHistoryEntry(value: unknown): value is FullSuiteDurationHistoryEntry {
    if (!isPlainRecord(value)) {
        return false;
    }
    return typeof value.timestamp_utc === 'string'
        && typeof value.task_id === 'string'
        && ['PASSED', 'FAILED', 'WARNED'].includes(String(value.status))
        && typeof value.command === 'string'
        && typeof value.config_signature_sha256 === 'string'
        && typeof value.duration_ms === 'number'
        && Number.isFinite(value.duration_ms)
        && value.duration_ms > 0
        && typeof value.timed_out === 'boolean'
        && (typeof value.cancelled === 'boolean' || value.cancelled === undefined)
        && (typeof value.retry_contaminated === 'boolean' || value.retry_contaminated === undefined)
        && (typeof value.exit_code === 'number' || value.exit_code === null);
}

export function classifyFullSuiteForecastSample(
    config: FullSuiteValidationConfig,
    entry: Pick<FullSuiteDurationHistoryEntry, 'status' | 'duration_ms' | 'timed_out' | 'cancelled' | 'retry_contaminated' | 'exit_code'>
): {
    eligible: boolean;
    reason: FullSuiteDurationForecastExclusionReason;
} {
    if (!Number.isFinite(entry.duration_ms) || entry.duration_ms <= 0) {
        return { eligible: false, reason: 'invalid_duration' };
    }
    if (entry.timed_out) {
        return { eligible: false, reason: 'timed_out' };
    }
    if (entry.cancelled === true) {
        return { eligible: false, reason: 'interrupted_or_cancelled' };
    }
    const isSuccessfulPass = entry.status === 'PASSED' && entry.exit_code === 0;
    // A retry-contaminated pass is still a conservative wall-clock sample for sizing future timeouts.
    if (entry.retry_contaminated === true && !isSuccessfulPass) {
        return { eligible: false, reason: 'retry_contaminated' };
    }
    if (entry.status !== 'PASSED') {
        return { eligible: false, reason: 'non_passing_status' };
    }
    if (entry.exit_code !== 0) {
        return { eligible: false, reason: 'nonzero_exit' };
    }
    const outlierThresholdMs = Math.max(
        FULL_SUITE_DURATION_OUTLIER_MIN_MS,
        config.timeout_ms * FULL_SUITE_DURATION_OUTLIER_TIMEOUT_MULTIPLIER
    );
    if (entry.duration_ms > outlierThresholdMs) {
        return { eligible: false, reason: 'outlier_duration' };
    }
    return { eligible: true, reason: 'none' };
}

export function readFullSuiteDurationHistory(repoRoot: string): {
    history: FullSuiteDurationHistory;
    warning: string | null;
} {
    const historyPath = resolveFullSuiteDurationHistoryPath(repoRoot);
    const emptyHistory: FullSuiteDurationHistory = {
        schema_version: 1,
        history_limit: FULL_SUITE_DURATION_HISTORY_LIMIT,
        updated_at_utc: new Date(0).toISOString(),
        entries: []
    };
    if (!fs.existsSync(historyPath)) {
        return { history: emptyHistory, warning: null };
    }

    try {
        const parsed = JSON.parse(fs.readFileSync(historyPath, 'utf8')) as unknown;
        if (!isPlainRecord(parsed) || !Array.isArray(parsed.entries)) {
            return {
                history: emptyHistory,
                warning: `Full-suite duration history at ${normalizePath(historyPath)} is malformed; using configured timeout fallback.`
            };
        }
        return {
            history: {
                schema_version: 1,
                history_limit: FULL_SUITE_DURATION_HISTORY_LIMIT,
                updated_at_utc: typeof parsed.updated_at_utc === 'string'
                    ? parsed.updated_at_utc
                    : new Date(0).toISOString(),
                entries: parsed.entries.filter(isFullSuiteDurationHistoryEntry).slice(-FULL_SUITE_DURATION_HISTORY_LIMIT)
            },
            warning: null
        };
    } catch {
        return {
            history: emptyHistory,
            warning: `Full-suite duration history at ${normalizePath(historyPath)} is unreadable; using configured timeout fallback.`
        };
    }
}

export function recordFullSuiteValidationDuration(
    repoRoot: string,
    config: FullSuiteValidationConfig,
    entry: Omit<FullSuiteDurationHistoryEntry, 'command' | 'config_signature_sha256'>
): FullSuiteDurationHistory {
    const historyPath = resolveFullSuiteDurationHistoryPath(repoRoot);
    const signature = buildFullSuiteConfigSignature(config);
    const { history } = readFullSuiteDurationHistory(repoRoot);
    const sampleClassification = classifyFullSuiteForecastSample(config, entry);
    const entries = [
        ...history.entries.filter((candidate) => candidate.config_signature_sha256 === signature),
        {
            ...entry,
            command: redactSecretText(config.command),
            config_signature_sha256: signature,
            forecast_sample_eligible: sampleClassification.eligible,
            forecast_exclusion_reason: sampleClassification.reason
        }
    ].slice(-FULL_SUITE_DURATION_HISTORY_LIMIT);
    const nextHistory: FullSuiteDurationHistory = {
        schema_version: 1,
        history_limit: FULL_SUITE_DURATION_HISTORY_LIMIT,
        updated_at_utc: new Date().toISOString(),
        entries
    };
    fs.mkdirSync(path.dirname(historyPath), { recursive: true });
    fs.writeFileSync(historyPath, `${JSON.stringify(nextHistory, null, 2)}\n`, 'utf8');
    return nextHistory;
}

export function buildFullSuiteDurationHistoryComparison(
    repoRoot: string,
    config: FullSuiteValidationConfig,
    currentDurationMs: number
): FullSuiteDurationHistoryComparison {
    const historyPath = resolveFullSuiteDurationHistoryPath(repoRoot);
    const signature = buildFullSuiteConfigSignature(config);
    const { history } = readFullSuiteDurationHistory(repoRoot);
    const previousSamples = history.entries
        .filter((entry) => entry.config_signature_sha256 === signature)
        .filter((entry) => Number.isFinite(entry.duration_ms) && entry.duration_ms > 0)
        .filter((entry) => classifyFullSuiteForecastSample(config, entry).eligible)
        .slice(-FULL_SUITE_DURATION_HISTORY_LIMIT);
    const previousDurations = previousSamples.map((entry) => entry.duration_ms);
    const previousAverageDurationMs = previousDurations.length > 0
        ? Math.round(previousDurations.reduce((total, duration) => total + duration, 0) / previousDurations.length)
        : null;
    const previousBestDurationMs = previousDurations.length > 0 ? Math.min(...previousDurations) : null;
    const previousLatestDurationMs = previousDurations.length > 0 ? previousDurations[previousDurations.length - 1] : null;
    return {
        history_path: normalizePath(historyPath),
        previous_sample_count: previousSamples.length,
        previous_average_duration_ms: previousAverageDurationMs,
        previous_best_duration_ms: previousBestDurationMs,
        previous_latest_duration_ms: previousLatestDurationMs,
        current_duration_ms: currentDurationMs,
        delta_vs_previous_average_ms: previousAverageDurationMs === null ? null : previousAverageDurationMs - currentDurationMs,
        delta_vs_previous_best_ms: previousBestDurationMs === null ? null : previousBestDurationMs - currentDurationMs,
        delta_vs_previous_latest_ms: previousLatestDurationMs === null ? null : previousLatestDurationMs - currentDurationMs
    };
}

export function buildFullSuiteTimeoutForecast(
    repoRoot: string,
    config: FullSuiteValidationConfig
): FullSuiteTimeoutForecast {
    const historyPath = resolveFullSuiteDurationHistoryPath(repoRoot);
    const signature = buildFullSuiteConfigSignature(config);
    const { history, warning } = readFullSuiteDurationHistory(repoRoot);
    const matchingEntries = history.entries
        .filter((entry) => entry.config_signature_sha256 === signature)
        .filter((entry) => Number.isFinite(entry.duration_ms) && entry.duration_ms > 0)
        .slice(-FULL_SUITE_DURATION_HISTORY_LIMIT);
    const classifiedEntries = matchingEntries.map((entry) => ({
        entry,
        classification: classifyFullSuiteForecastSample(config, entry)
    }));
    const samples = classifiedEntries
        .filter(({ classification }) => classification.eligible)
        .map(({ entry }) => entry);
    const excludedSampleReasons: Partial<Record<FullSuiteDurationForecastExclusionReason, number>> = {};
    for (const { classification } of classifiedEntries) {
        if (classification.eligible) {
            continue;
        }
        excludedSampleReasons[classification.reason] = (excludedSampleReasons[classification.reason] || 0) + 1;
    }
    const excludedSampleCount = classifiedEntries.length - samples.length;
    const configuredTimeoutSeconds = Math.ceil(config.timeout_ms / 1000);
    if (samples.length === 0) {
        return {
            history_path: normalizePath(historyPath),
            sample_count: 0,
            excluded_sample_count: excludedSampleCount,
            excluded_sample_reasons: excludedSampleReasons,
            average_duration_seconds: null,
            high_watermark_duration_seconds: null,
            recommended_timeout_seconds: configuredTimeoutSeconds,
            safety_margin_seconds: null,
            recommendation_source: 'config_timeout',
            configured_timeout_seconds: configuredTimeoutSeconds,
            warning
        };
    }

    const averageDurationSeconds = samples.reduce((total, entry) => total + entry.duration_ms / 1000, 0) / samples.length;
    const highWatermarkDurationSeconds = Math.max(...samples.map((entry) => entry.duration_ms / 1000));
    const recommendedTimeoutSeconds = Math.ceil(Math.max(
        averageDurationSeconds * (1 + FULL_SUITE_TIMEOUT_MARGIN_RATIO),
        averageDurationSeconds + FULL_SUITE_TIMEOUT_MIN_MARGIN_SECONDS,
        highWatermarkDurationSeconds * (1 + FULL_SUITE_TIMEOUT_MARGIN_RATIO),
        highWatermarkDurationSeconds + FULL_SUITE_TIMEOUT_MIN_MARGIN_SECONDS
    ));
    return {
        history_path: normalizePath(historyPath),
        sample_count: samples.length,
        excluded_sample_count: excludedSampleCount,
        excluded_sample_reasons: excludedSampleReasons,
        average_duration_seconds: Math.round(averageDurationSeconds * 10) / 10,
        high_watermark_duration_seconds: Math.round(highWatermarkDurationSeconds * 10) / 10,
        recommended_timeout_seconds: recommendedTimeoutSeconds,
        safety_margin_seconds: Math.round((recommendedTimeoutSeconds - highWatermarkDurationSeconds) * 10) / 10,
        recommendation_source: 'history',
        configured_timeout_seconds: configuredTimeoutSeconds,
        warning
    };
}

export function formatFullSuiteTimeoutForecast(forecast: FullSuiteTimeoutForecast): string {
    const exclusionSummary = formatFullSuiteForecastExclusionSummary(forecast);
    if (forecast.recommendation_source === 'history' && forecast.average_duration_seconds !== null) {
        const excludedFragment = exclusionSummary ? `; ${exclusionSummary}` : '';
        return `Recommended full-suite command timeout: ${forecast.recommended_timeout_seconds}s `
            + `(target sample ${FULL_SUITE_DURATION_HISTORY_LIMIT} recent run(s); eligible ${forecast.sample_count} run(s) avg ${forecast.average_duration_seconds}s; `
            + `max ${forecast.high_watermark_duration_seconds}s; `
            + `safety margin over max +${forecast.safety_margin_seconds}s = 20% but at least 30s${excludedFragment}).`;
    }
    const suffix = forecast.warning ? ` ${forecast.warning}` : '';
    if (exclusionSummary) {
        return `Recommended full-suite command timeout: ${forecast.recommended_timeout_seconds}s `
            + `(no eligible recent matching full-suite duration history; ${exclusionSummary}; using configured timeout).${suffix}`;
    }
    return `Recommended full-suite command timeout: ${forecast.recommended_timeout_seconds}s `
        + `(no recent matching full-suite duration history; using configured timeout).${suffix}`;
}

function formatFullSuiteForecastExclusionSummary(forecast: FullSuiteTimeoutForecast): string | null {
    if (!forecast.excluded_sample_count) {
        return null;
    }
    const reasons = Object.entries(forecast.excluded_sample_reasons)
        .filter(([, count]) => typeof count === 'number' && count > 0)
        .map(([reason, count]) => `${reason}=${count}`)
        .sort();
    if (reasons.length === 0) {
        return `${forecast.excluded_sample_count} matching run(s) excluded from forecast`;
    }
    return `${forecast.excluded_sample_count} matching run(s) excluded from forecast (${reasons.join(', ')})`;
}

function commandIncludesShardMode(command: string): boolean {
    return /\btest:sharded\b/i.test(command) || /--garda-shards(?:\s+|=)\d+/i.test(command);
}

function commandIncludesReuseAwareMode(command: string): boolean {
    return /\bbuild-prep\b/i.test(command)
        || /\breuse\b/i.test(command)
        || /\bNODE_FOUNDATION_BUILD_REUSE\b/i.test(command)
        || /\bPUBLISH_RUNTIME_BUILD_REUSE\b/i.test(command)
        || /\bSCRIPTS_BUILD_REUSE\b/i.test(command);
}

export function buildFullSuitePerformanceGuidance(command: string): FullSuitePerformanceGuidance {
    const trimmedCommand = redactSecretText(String(command || '').trim());
    const sharded = commandIncludesShardMode(trimmedCommand);
    const reuseAware = commandIncludesReuseAwareMode(trimmedCommand);
    const mode = sharded && reuseAware
        ? 'optimized_sharded_reuse_aware'
        : sharded
            ? 'optimized_sharded'
            : reuseAware
                ? 'optimized_reuse_aware'
                : 'standard';
    return {
        mode,
        optimized: mode !== 'standard',
        mandatory_boundary: 'mandatory full-suite evidence; not a smoke, fast, or release-smoke substitute',
        optimized_command: mode !== 'standard' && trimmedCommand ? trimmedCommand : null,
        fallback_command: null
    };
}

export function formatFullSuitePerformanceGuidance(command: string): string {
    const guidance = buildFullSuitePerformanceGuidance(command);
    const parts = [
        `mode=${guidance.mode}`,
        `optimized=${String(guidance.optimized)}`,
        'boundary=mandatory_full_suite_not_smoke_or_fast'
    ];
    if (guidance.optimized_command) {
        parts.push(`optimized_command="${guidance.optimized_command}"`);
    }
    if (guidance.fallback_command) {
        parts.push(`fallback_command="${guidance.fallback_command}"`);
    }
    return parts.join('; ');
}
