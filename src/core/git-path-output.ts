export interface GitNumstatEntry {
    additions: number | null;
    deletions: number | null;
    path: string;
    previousPath: string | null;
}

export interface GitPorcelainV1Entry {
    indexStatus: string;
    worktreeStatus: string;
    path: string;
    previousPath: string | null;
}

export interface GitNameStatusEntry {
    status: string;
    path: string;
    previousPath: string | null;
}

export function splitNulRecords(output: string | Buffer): string[] {
    const text = typeof output === 'string' ? output : output.toString('utf8');
    if (!text) return [];
    const records = text.split('\0');
    if (records.at(-1) === '') records.pop();
    return records;
}

export function parseNumstatZ(output: string | Buffer): GitNumstatEntry[] {
    const records = splitNulRecords(output);
    const entries: GitNumstatEntry[] = [];
    for (let index = 0; index < records.length;) {
        const header = records[index++];
        const firstTab = header.indexOf('\t');
        const secondTab = header.indexOf('\t', firstTab + 1);
        if (firstTab <= 0 || secondTab <= firstTab + 1) {
            throw new Error('Git numstat output contains a malformed record.');
        }
        const additions = header.slice(0, firstTab);
        const deletions = header.slice(firstTab + 1, secondTab);
        if (!/^(?:[0-9]+|-)$/u.test(additions) || !/^(?:[0-9]+|-)$/u.test(deletions)) {
            throw new Error('Git numstat output contains invalid counters.');
        }
        const inlinePath = header.slice(secondTab + 1);
        const previousPath = inlinePath ? null : records[index++];
        const filePath = inlinePath || records[index++];
        if (!filePath || previousPath === '') {
            throw new Error('Git numstat output contains incomplete rename/copy paths.');
        }
        entries.push({
            additions: additions === '-' ? null : Number(additions),
            deletions: deletions === '-' ? null : Number(deletions),
            path: filePath,
            previousPath: previousPath ?? null
        });
    }
    return entries;
}

export function parsePorcelainV1Z(output: string | Buffer): GitPorcelainV1Entry[] {
    const records = splitNulRecords(output);
    const entries: GitPorcelainV1Entry[] = [];
    for (let index = 0; index < records.length;) {
        const record = records[index++];
        if (record.length < 4 || record.charAt(2) !== ' ') {
            throw new Error(`Git porcelain output contains a malformed record: '${record.slice(0, 20)}'.`);
        }
        const indexStatus = record.charAt(0);
        const worktreeStatus = record.charAt(1);
        const status = `${indexStatus}${worktreeStatus}`;
        const renameOrCopy = /[RC]/u.test(status);
        const previousPath = renameOrCopy ? records[index++] : null;
        if (renameOrCopy && !previousPath) {
            throw new Error(`Git porcelain output omitted the source path for status '${status}'.`);
        }
        entries.push({ indexStatus, worktreeStatus, path: record.slice(3), previousPath });
    }
    return entries;
}

export function parseNameStatusZ(output: string | Buffer): GitNameStatusEntry[] {
    const records = splitNulRecords(output);
    const entries: GitNameStatusEntry[] = [];
    for (let index = 0; index < records.length;) {
        const status = records[index++];
        const firstPath = records[index++];
        const renameOrCopy = /^[RC]/u.test(status);
        const filePath = renameOrCopy ? records[index++] : firstPath;
        if (!/^[ACDMRTUXB][0-9]*$/u.test(status) || !firstPath || !filePath) {
            throw new Error('Git name-status output contains a malformed or incomplete record.');
        }
        entries.push({ status, path: filePath, previousPath: renameOrCopy ? firstPath : null });
    }
    return entries;
}
