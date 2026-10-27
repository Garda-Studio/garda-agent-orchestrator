export function parseTimestamp(value: unknown): Date {
    if (value == null) return new Date(0);
    const text = String(value).trim();
    if (!text) return new Date(0);
    const candidate = text.replace('Z', '+00:00');
    try {
        const parsed = new Date(candidate);
        if (isNaN(parsed.getTime())) return new Date(0);
        return parsed;
    } catch {
        return new Date(0);
    }
}

export function formatTimestamp(value: unknown): string | null {
    if (value == null) return null;
    if (value instanceof Date) {
        if (isNaN(value.getTime())) return null;
        return value.toISOString();
    }
    const text = String(value).trim();
    if (!text) return null;
    try {
        const parsed = new Date(text.replace('Z', '+00:00'));
        if (isNaN(parsed.getTime())) return text;
        return parsed.toISOString();
    } catch {
        return text;
    }
}

