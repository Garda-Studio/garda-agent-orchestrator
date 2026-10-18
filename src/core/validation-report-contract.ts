import { isPlainRecord } from './records';
import { validationPathKey, validationRelativePath } from './validation-relative-path';
import type { ValidationFileObservation } from './project-validation-identity';

export const MAX_VALIDATION_REPORT_FILES = 32;
export const MAX_VALIDATION_REPORT_BYTES = 16 * 1024 * 1024;

export interface ValidationReportFile {
    path: string;
    max_bytes: number;
}

export interface ValidationReportCaptureStart {
    schema_version: 1;
    started_at: string;
    anchor: ValidationFileObservation;
    declarations: ValidationReportFile[];
    before: Array<ValidationFileObservation | null>;
}

export interface CapturedValidationReportFile {
    observation: ValidationFileObservation;
    content_base64: string;
}

export interface ValidationReportCapture {
    start: ValidationReportCaptureStart;
    completed_at: string;
    reports: CapturedValidationReportFile[];
    violations: string[];
}

export interface ValidationReportEvidenceBinding {
    declarations: ValidationReportFile[];
    start_sha256: string;
    evidence_directory: string;
}

export function parseValidationReportArguments(value: unknown): ValidationReportFile[] {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > MAX_VALIDATION_REPORT_FILES)
        throw new Error('Report arguments require a bounded array of declarations.');
    return parseValidationReportFiles(value.map(item => {
        if (typeof item !== 'string') return item;
        if (item.length > 32768) throw new Error('Report argument exceeds its byte bound.');
        return JSON.parse(item) as unknown;
    }));
}

export function parseValidationReportFiles(value: unknown): ValidationReportFile[] {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > MAX_VALIDATION_REPORT_FILES)
        throw new Error('Report files require a bounded array of declarations.');
    const paths = new Set<string>();
    let maximumBytes = 0;
    return Array.from(value, item => {
        if (!isPlainRecord(item) || Object.keys(item).some(key => !['path', 'max_bytes'].includes(key)))
            throw new Error('Report file declaration has unsupported fields.');
        const relative = validationRelativePath(item.path, 'report path');
        if (Buffer.byteLength(relative) > 4096) throw new Error('Report path exceeds its byte bound.');
        if (relative.split('/').some(part => part.toLowerCase() === '.git'))
            throw new Error('Git control files cannot be validation reports.');
        const key = validationPathKey(relative);
        if (paths.has(key)) throw new Error('Report file declarations contain a duplicate path.');
        paths.add(key);
        if (!Number.isSafeInteger(item.max_bytes) || Number(item.max_bytes) < 1)
            throw new Error('Report file byte bound must be a positive safe integer.');
        maximumBytes += Number(item.max_bytes);
        if (maximumBytes > MAX_VALIDATION_REPORT_BYTES) throw new Error('Report files exceed the aggregate byte bound.');
        return { path: relative, max_bytes: Number(item.max_bytes) };
    });
}
