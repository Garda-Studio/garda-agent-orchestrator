import * as path from 'node:path';
import { assertCanonicalTaskId } from '../../core/task-ids';
import { readCompactOutput, withCompactStore } from '../../core/compact/store';
import { runCompactInspection, type CompactInspection } from '../../core/compact/inspection';
import { compactPreview, COMPACT_ENVELOPE_CHARS } from '../../core/compact/contract';
import { readCompactSettings } from '../../core/compact/settings';

export const COMPACT_HELP = `garda compact <git status|git diff|file|rg|read|search|usage> --task-id <id> [options]
  --repo-root <path>          Workspace (default .)
  git diff --path <path>      Scoped diff; optional --staged
  git status                 Short changed-path listing; optional --path
  file --path <path>          Source lines; --from 1 --lines 80 or --metadata
  rg --path <path> --query <text>   Literal search; optional --regex
  read --ref <id>             Retained bytes; --stream stdout|stderr --offset 0 or --tail
  search --ref <id> --query <text>  Search retained bytes; same stream/offset options
  usage                      Cache bytes and runs, no payloads
No arbitrary shell commands. Secrets are not masked. Captures have hard limits.
Cleanup runs at task start/completion, never on a timer. Short output stays inline.`;

const VALUE_OPTIONS = new Set(['repo-root', 'task-id', 'path', 'query', 'from', 'lines', 'ref', 'stream', 'offset']);
const FLAG_OPTIONS = new Set(['staged', 'metadata', 'regex', 'tail']);

export function parseCompactArguments(argv: string[]): { operation: string; values: Record<string, string>; flags: Set<string> } {
    const args = [...argv];
    let operation = args.shift() || '';
    if (operation === 'git') operation += ` ${args.shift() || ''}`;
    const values: Record<string, string> = {};
    const flags = new Set<string>();
    while (args.length) {
        const option = args.shift()!;
        const name = option.slice(2);
        if (!option.startsWith('--') || Object.hasOwn(values, name) || flags.has(name)) throw new Error(`Invalid or repeated compact option: ${option}`);
        if (FLAG_OPTIONS.has(name)) flags.add(name);
        else if (VALUE_OPTIONS.has(name) && args.length) values[name] = args.shift()!;
        else throw new Error(`Unknown or missing compact option: ${option}`);
    }
    const allowed: Record<string, string[]> = {
        'git status': ['path'], 'git diff': ['path', 'staged'], file: ['path', 'from', 'lines', 'metadata'],
        rg: ['path', 'query', 'regex'], read: ['ref', 'stream', 'offset', 'tail'], search: ['ref', 'stream', 'offset', 'query'], usage: []
    };
    if (!Object.hasOwn(allowed, operation)) throw new Error('Unsupported compact operation. Use compact --help.');
    for (const key of [...Object.keys(values), ...flags]) {
        if (!['repo-root', 'task-id', ...allowed[operation]].includes(key)) throw new Error(`Option --${key} is unsupported for ${operation}.`);
    }
    return { operation, values, flags };
}

export async function handleCompact(argv: string[]): Promise<void> {
    if (!argv.length || argv[0] === '--help' || argv[0] === 'help') { console.log(COMPACT_HELP); return; }
    const { operation, values, flags } = parseCompactArguments(argv);
    const root = path.resolve(values['repo-root'] || '.');
    if (operation === 'usage') { console.log(JSON.stringify(await withCompactStore(root, store => store.usage()))); return; }
    const taskId = assertCanonicalTaskId(values['task-id'] || '');
    if (operation === 'read' || operation === 'search') {
        if (operation === 'search' && !values.query) throw new Error('Search requires --query.');
        const result = await readCompactOutput(root, { taskId, ref: values.ref || '', stream: (values.stream || 'stdout') as 'stdout' | 'stderr', offset: Number(values.offset || 0), tail: flags.has('tail'), ...(operation === 'search' ? { query: values.query } : {}) });
        console.log(`${result.text}\nCapture: ${result.complete ? 'complete' : 'partial'}; storedBytes=${result.bytes}; scannedBytes=${result.scannedBytes}; nextOffset=${result.nextOffset ?? 'end'}`);
        return;
    }
    let request: CompactInspection;
    if (operation === 'file') request = { kind: 'file', path: values.path || '', from: Number(values.from || 1), lines: Number(values.lines || 80), metadata: flags.has('metadata') };
    else if (operation === 'rg') request = { kind: 'rg', path: values.path || '', query: values.query || '', regex: flags.has('regex') };
    else request = { kind: 'git', operation: operation === 'git diff' ? 'diff' : 'status', path: values.path, staged: flags.has('staged') };
    const result = await runCompactInspection(root, taskId, request);
    const settings = readCompactSettings(root);
    const streams = [compactPreview(result.stdout, settings).text, compactPreview(result.stderr, settings).text].filter(Boolean);
    const status = result.exitCode || !result.complete ? `Exit: ${result.exitCode}; capture=${result.complete ? 'complete' : 'partial'}${result.sinkError ? `; ${compactPreview(result.sinkError).text.slice(0, 1000)}` : ''}\n` : '';
    const cli = process.argv[1] || 'bin/garda.js';
    const quote = (value: string): string => `'${value.replace(/'/g, process.platform === 'win32' ? "''" : "'\"'\"'")}'`;
    const hint = result.ref ? `\nMore: node ${quote(cli)} compact read --repo-root ${quote(root)} --task-id ${taskId} --ref ${result.ref} --stream ${result.stderr && !result.stdout ? 'stderr' : 'stdout'}\n` : '';
    if (hint.length > 2000) throw new Error('Repository/CLI path is too long for a bounded retrieval hint.');
    console.log(status + streams.join('\n').slice(0, COMPACT_ENVELOPE_CHARS - status.length - hint.length - 1) + hint);
    process.exitCode = result.exitCode || (result.complete ? 0 : 1);
}
