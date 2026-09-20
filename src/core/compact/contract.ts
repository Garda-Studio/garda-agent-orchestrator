export interface CompactSettings {
    enabled: boolean;
    git: boolean;
    file: boolean;
    rg: boolean;
    previewLines: number;
    previewChars: number;
    runBytes: number;
    taskBytes: number;
    workspaceBytes: number;
    maxRuns: number;
}

export const DEFAULT_COMPACT_SETTINGS: Readonly<CompactSettings> = Object.freeze({
    enabled: true, git: true, file: true, rg: true,
    previewLines: 20, previewChars: 3000,
    runBytes: 16 * 1024 * 1024, taskBytes: 64 * 1024 * 1024,
    workspaceBytes: 256 * 1024 * 1024, maxRuns: 2048
});
export const COMPACT_ENVELOPE_CHARS = 8000;
export const COMPACT_METADATA_BYTES = 8192;

export function validateCompactSettings(input: unknown): CompactSettings {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid compact settings.');
    const result = { ...DEFAULT_COMPACT_SETTINGS };
    for (const [key, value] of Object.entries(input)) {
        if (!Object.hasOwn(DEFAULT_COMPACT_SETTINGS, key)) throw new Error(`Unknown compact setting: ${key}`);
        const defaultValue = DEFAULT_COMPACT_SETTINGS[key as keyof CompactSettings];
        if (typeof defaultValue === 'boolean') {
            if (typeof value !== 'boolean') throw new Error(`Expected boolean: ${key}`);
        } else if (!Number.isSafeInteger(value) || value < 1 || value > defaultValue) {
            throw new Error(`Invalid compact limit: ${key} (maximum ${defaultValue})`);
        }
        Object.assign(result, { [key]: value });
    }
    if (result.runBytes < COMPACT_METADATA_BYTES + 1024 || result.runBytes > result.taskBytes || result.taskBytes > result.workspaceBytes) {
        throw new Error('Compact limits require metadata headroom and run <= task <= workspace.');
    }
    if (result.previewChars < 128 || result.previewLines < 3) throw new Error('Preview requires at least 128 chars and 3 lines.');
    return result;
}

export function displayCompactText(text: string): string {
    return text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, value => `\\x${value.charCodeAt(0).toString(16).padStart(2, '0')}`);
}

export function compactPreview(text: string, settings: CompactSettings = { ...DEFAULT_COMPACT_SETTINGS }): { text: string; omitted: boolean } {
    const safe = displayCompactText(text);
    const lines = safe.split('\n');
    if (safe.length <= settings.previewChars && lines.length <= settings.previewLines) return { text: safe, omitted: false };
    const marker = '\n... omitted ...\n';
    const chars = Math.floor((settings.previewChars - marker.length) / 2);
    const count = Math.max(1, Math.floor((settings.previewLines - 2) / 2));
    return {
        text: lines.slice(0, count).join('\n').slice(0, chars) + marker + lines.slice(-count).join('\n').slice(-chars),
        omitted: true
    };
}
