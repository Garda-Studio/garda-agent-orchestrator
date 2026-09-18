import * as fs from 'node:fs';
import { isUtf8 } from 'node:buffer';
import {
    BOOLEAN_FALSE_VALUES,
    BOOLEAN_TRUE_VALUES
} from '../../core/constants';
import { fileSha256, stringSha256 } from '../../core/file-hashing';
import {
    appendMetricJsonLines,
    recordToxinMetricsSnapshot,
    shouldRecordToxinMetricsSnapshot
} from '../../runtime/toxin-metrics';

export interface ToStringArrayOptions {
    trimValues?: boolean;
}

/**
 * Convert unknown value to a plain object record or null.
 */
export function toPlainRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

/**
 * Parse boolean-like values, matching Python/PS parse_bool.
 */
export function parseBool(value: unknown, defaultValue = false): boolean {
    if (value == null) return !!defaultValue;
    if (typeof value === 'boolean') return value;
    const text = String(value).trim().toLowerCase();
    if (BOOLEAN_TRUE_VALUES.includes(text)) return true;
    if (BOOLEAN_FALSE_VALUES.includes(text)) return false;
    return !!defaultValue;
}

export { fileSha256, stringSha256 };

/**
 * Count non-empty lines in a file.
 */
export function countFileLines(filePath: string): number {
    try {
        if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return 0;
        const bytes = fs.readFileSync(filePath);
        if (bytes.includes(0) || !isUtf8(bytes)) return 0;
        const content = bytes.toString('utf8');
        return content.split('\n').filter(line => line.trimEnd() !== '').length;
    } catch {
        return 0;
    }
}

/**
 * Append a JSON line to a metrics file.
 */
export function appendMetricsEvent(
    metricsPath: string,
    eventObject: Record<string, unknown>,
    emitMetrics: boolean,
    repoRoot?: string
): void {
    if (!emitMetrics || !metricsPath) return;
    const resolvedMetricsPath = String(metricsPath);
    if (!appendMetricJsonLines(resolvedMetricsPath, [eventObject])) {
        // metrics are best-effort
        return;
    }
    if (!repoRoot) {
        return;
    }
    try {
        if (shouldRecordToxinMetricsSnapshot(resolvedMetricsPath)) {
            recordToxinMetricsSnapshot(repoRoot, { metricsPath: resolvedMetricsPath });
        }
    } catch {
        // toxin metrics are best-effort
    }
}

/**
 * Convert value(s) to a flat string array, matching gate_utils.to_string_array.
 */
export function toStringArray(value: unknown, options: ToStringArrayOptions = {}): string[] {
    const trimValues = options.trimValues || false;
    if (value == null) return [];
    if (typeof value === 'string') {
        const text = trimValues ? value.trim() : value;
        return (text && text.trim()) ? [text] : [];
    }
    if (Array.isArray(value)) {
        const result = [];
        for (const item of value) {
            if (item == null) continue;
            let text = String(item);
            if (trimValues) text = text.trim();
            if (!text || !text.trim()) continue;
            result.push(text);
        }
        return result;
    }
    const text = trimValues ? String(value).trim() : String(value);
    return (text && text.trim()) ? [text] : [];
}
