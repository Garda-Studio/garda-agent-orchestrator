export interface CompactSettings {
    enabled: boolean;
    git: boolean;
    file: boolean;
    rg: boolean;
    previewLines: number;
    previewChars: number;
    exactBytes: number;
    readBytes: number;
    searchContext: number;
    runBytes: number;
    taskBytes: number;
    workspaceBytes: number;
    maxRuns: number;
}

export const DEFAULT_COMPACT_SETTINGS: Readonly<CompactSettings> = Object.freeze({
    enabled: true, git: true, file: true, rg: true,
    previewLines: 20, previewChars: 3000,
    exactBytes: 8192, readBytes: 4096, searchContext: 2,
    runBytes: 16 * 1024 * 1024, taskBytes: 64 * 1024 * 1024,
    workspaceBytes: 256 * 1024 * 1024, maxRuns: 2048
});
export const COMPACT_ENVELOPE_CHARS = 28000;
export const COMPACT_METADATA_BYTES = 8192;
export const COMPACT_TEXT_CHARS = 12000;
export const MAX_COMPACT_SETTINGS = Object.freeze({ ...DEFAULT_COMPACT_SETTINGS,
    previewLines: 100, previewChars: 6000, exactBytes: 8192, readBytes: 8192, searchContext: 8 });

export function validateCompactSettings(input: unknown): CompactSettings {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid compact settings.');
    const result = { ...DEFAULT_COMPACT_SETTINGS };
    for (const [key, value] of Object.entries(input)) {
        if (!Object.hasOwn(DEFAULT_COMPACT_SETTINGS, key)) throw new Error(`Unknown compact setting: ${key}`);
        const defaultValue = DEFAULT_COMPACT_SETTINGS[key as keyof CompactSettings];
        if (typeof defaultValue === 'boolean') {
            if (typeof value !== 'boolean') throw new Error(`Expected boolean: ${key}`);
        } else if (!Number.isSafeInteger(value) || value < (key === 'searchContext' ? 0 : 1) || value > Number(MAX_COMPACT_SETTINGS[key as keyof CompactSettings])) {
            throw new Error(`Invalid compact limit: ${key} (maximum ${MAX_COMPACT_SETTINGS[key as keyof CompactSettings]})`);
        }
        Object.assign(result, { [key]: value });
    }
    if (result.runBytes < COMPACT_METADATA_BYTES + 1024 || result.runBytes > result.taskBytes || result.taskBytes > result.workspaceBytes) {
        throw new Error('Compact limits require metadata headroom and run <= task <= workspace.');
    }
    if (result.previewChars < 128 || result.previewLines < 3) throw new Error('Preview requires at least 128 chars and 3 lines.');
    if (result.exactBytes < 256 || result.readBytes < 256) throw new Error('Read budgets require at least 256 bytes.');
    return result;
}

export function displayCompactText(text: string): string {
    return text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, value => `\\x${value.charCodeAt(0).toString(16).padStart(2, '0')}`);
}

export function compactPreview(text: string, settings: CompactSettings = { ...DEFAULT_COMPACT_SETTINGS }): { text: string; omitted: boolean } {
    const safe = displayCompactText(text);
    const lines = safe.replace(/\n$/, '').split('\n');
    if (safe.length <= settings.previewChars) return { text: safe, omitted: false };
    const marker = '\n... omitted ...\n';
    const chars = Math.floor((settings.previewChars - marker.length) / 2);
    const count = Math.max(1, Math.floor((settings.previewLines - 2) / 2));
    return {
        text: lines.slice(0, count).join('\n').slice(0, chars) + marker + lines.slice(-count).join('\n').slice(-chars),
        omitted: true
    };
}

/** Bound rendered text as well as raw bytes, keeping valid UTF-8 characters whole. */
export function compactTextPage(bytes: Buffer, maxBytes: number, maxChars = COMPACT_TEXT_CHARS): { text: string; consumed: number } {
    let consumed = 0;
    let text = '';
    while (consumed < bytes.length) {
        const first = bytes[consumed];
        let width = first < 0x80 ? 1 : first >= 0xc2 && first <= 0xdf ? 2 : first >= 0xe0 && first <= 0xef ? 3 : first >= 0xf0 && first <= 0xf4 ? 4 : 1;
        let character = bytes.subarray(consumed, consumed + width).toString('utf8');
        if (!Buffer.from(character).equals(bytes.subarray(consumed, consumed + width))) { width = 1; character = first < 0x80 ? String.fromCharCode(first) : '\ufffd'; }
        const rendered = displayCompactText(character);
        if (consumed + width > maxBytes || text.length + rendered.length > maxChars) break;
        text += rendered;
        consumed += width;
    }
    return { text, consumed };
}
