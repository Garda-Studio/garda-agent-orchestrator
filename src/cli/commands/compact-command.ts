import * as path from 'node:path';
import { assertCanonicalTaskId } from '../../core/task-ids';
import { readCompactOutput, withCompactStore } from '../../core/compact/store';
import { runCompactInspection, type CompactInspection } from '../../core/compact/inspection';
import { compactPreview, compactTextPage, displayCompactText, COMPACT_ENVELOPE_CHARS } from '../../core/compact/contract';
import { readCompactSettings } from '../../core/compact/settings';

export const COMPACT_HELP = `garda compact <git status|git diff|file|rg|read|search|usage> --task-id <id> [options]
  --repo-root <path>          Workspace (default .)
  git diff --path <path>      Scoped diff; optional --staged
  git status                 Short changed-path listing; optional --path
  file --path <path>          Source lines; --from 1 --lines 80 or --metadata
  rg --path <path> --query <text>   Literal search; optional --regex; runtime paths must name an exact file
  read --ref <id>             Retained bytes; --stream stdout|stderr --offset 0 or --tail
                             --max-bytes 4096 (256..8192); or --from-line 1 --lines 80
  search --ref <id> --query <text>  Repeat --query up to 8 times (literal OR)
                             --context 2 (0..8 lines); --offset for continuation
  usage                      Cache bytes and runs, no payloads
No arbitrary shell commands. Secrets are not masked. Captures have hard limits.
Cleanup runs at task start/completion, never on a timer. Short output stays inline.`;

const VALUE_OPTIONS = new Set(['repo-root', 'task-id', 'path', 'query', 'from', 'lines', 'ref', 'stream', 'offset', 'max-bytes', 'from-line', 'context']);
const FLAG_OPTIONS = new Set(['staged', 'metadata', 'regex', 'tail']);

export function parseCompactArguments(argv: string[]): { operation: string; values: Record<string, string>; flags: Set<string>; queries: string[] } {
    const args = [...argv];
    let operation = args.shift() || '';
    if (operation === 'git') operation += ` ${args.shift() || ''}`;
    const values: Record<string, string> = {};
    const flags = new Set<string>();
    const queries: string[] = [];
    while (args.length) {
        const option = args.shift()!;
        const name = option.slice(2);
        if (option === '--query' && operation === 'search' && args.length) {
            queries.push(args.shift()!);
            if (queries.length > 8) throw new Error('Search accepts at most 8 queries.');
            continue;
        }
        if (!option.startsWith('--') || Object.hasOwn(values, name) || flags.has(name)) throw new Error(`Invalid or repeated compact option: ${option}`);
        if (FLAG_OPTIONS.has(name)) flags.add(name);
        else if (VALUE_OPTIONS.has(name) && args.length) values[name] = args.shift()!;
        else throw new Error(`Unknown or missing compact option: ${option}`);
    }
    const allowed: Record<string, string[]> = {
        'git status': ['path'], 'git diff': ['path', 'staged'], file: ['path', 'from', 'lines', 'metadata'],
        rg: ['path', 'query', 'regex'], read: ['ref', 'stream', 'offset', 'tail', 'max-bytes', 'from-line', 'lines'], search: ['ref', 'stream', 'offset', 'query', 'context'], usage: []
    };
    if (!Object.hasOwn(allowed, operation)) throw new Error('Unsupported compact operation. Use compact --help.');
    for (const key of [...Object.keys(values), ...flags]) {
        if (!['repo-root', 'task-id', ...allowed[operation]].includes(key)) throw new Error(`Option --${key} is unsupported for ${operation}.`);
    }
    return { operation, values, flags, queries };
}

function sourceSummary(source: { path: string; from: number; to: number; eof: boolean } | undefined): string {
    return source ? `Source: ${displayCompactText(source.path).replace(/\n/g, '\\n')}; selected lines=${source.from}..${source.to}; sourceEOF=${source.eof}; search covers this capture only.\n` : '';
}

function readHint(root: string, taskId: string, ref: string, stream: string, offset: number): string {
    const cli = process.argv[1] || 'bin/garda.js';
    const quote = (value: string): string => `'${value.replace(/'/g, process.platform === 'win32' ? "''" : "'\"'\"'")}'`;
    const hint = `node ${quote(cli)} compact read --repo-root ${quote(root)} --task-id ${taskId} --ref ${ref} --stream ${stream} --offset ${offset}`;
    if (hint.length > 2000) throw new Error('Repository/CLI path is too long for a bounded retrieval hint.');
    return hint;
}

export async function handleCompact(argv: string[]): Promise<void> {
    if (!argv.length || argv[0] === '--help' || argv[0] === 'help' || (argv.at(-1) === '--help' && ['file', 'rg', 'read', 'search', 'usage', 'git', 'git status', 'git diff'].includes(argv.slice(0, -1).join(' ')))) { console.log(COMPACT_HELP); return; }
    const { operation, values, flags, queries } = parseCompactArguments(argv);
    const root = path.resolve(values['repo-root'] || '.');
    if (operation === 'usage') { console.log(JSON.stringify(await withCompactStore(root, store => store.usage()))); return; }
    const taskId = assertCanonicalTaskId(values['task-id'] || '');
    if (operation === 'read' || operation === 'search') {
        if (operation === 'search' && !queries.length) throw new Error('Search requires --query.');
        const stream = (values.stream || 'stdout') as 'stdout' | 'stderr';
        const result = await readCompactOutput(root, { taskId, ref: values.ref || '', stream,
            ...(values.offset !== undefined ? { offset: Number(values.offset) } : {}), tail: flags.has('tail'),
            ...(values['max-bytes'] !== undefined ? { maxBytes: Number(values['max-bytes']) } : {}),
            ...(values['from-line'] !== undefined ? { fromLine: Number(values['from-line']) } : {}),
            ...(values.lines !== undefined ? { lines: Number(values.lines) } : {}),
            ...(operation === 'search' ? { queries, ...(values.context !== undefined ? { context: Number(values.context) } : {}) } : {}) });
        const next = result.nextOffset !== null && operation === 'read' ? `\nMore: ${readHint(root, taskId, values.ref, stream, result.nextOffset)}` : '';
        console.log(`${sourceSummary(result.source)}${result.text}\nCapture: ${result.complete ? 'complete' : 'partial'}; storedBytes=${result.bytes}; scannedBytes=${result.scannedBytes}; nextOffset=${result.nextOffset ?? 'end'}${next}`);
        return;
    }
    let request: CompactInspection;
    if (operation === 'file') request = { kind: 'file', path: values.path || '', from: Number(values.from || 1), lines: Number(values.lines || 80), metadata: flags.has('metadata') };
    else if (operation === 'rg') request = { kind: 'rg', path: values.path || '', query: values.query || '', regex: flags.has('regex') };
    else request = { kind: 'git', operation: operation === 'git diff' ? 'diff' : 'status', path: values.path, staged: flags.has('staged') };
    const result = await runCompactInspection(root, taskId, request);
    const settings = readCompactSettings(root);
    const exact = operation === 'file' && !flags.has('metadata');
    const page = exact ? compactTextPage(Buffer.from(result.stdout), settings.exactBytes) : undefined;
    const streams = [page?.text ?? compactPreview(result.stdout, settings).text, compactPreview(result.stderr, settings).text].filter(Boolean);
    const status = result.exitCode || !result.complete ? `Exit: ${result.exitCode}; capture=${result.complete ? 'complete' : 'partial'}${result.sinkError ? `; ${compactPreview(result.sinkError).text.slice(0, 1000)}` : ''}\n` : '';
    const hint = result.ref ? `\nMore: ${readHint(root, taskId, result.ref, result.stderr && !result.stdout ? 'stderr' : 'stdout', page?.consumed ?? 0)}\n` : '';
    const source = sourceSummary(result.source);
    console.log(status + source + streams.join('\n').slice(0, COMPACT_ENVELOPE_CHARS - status.length - source.length - hint.length - 1) + hint);
    process.exitCode = result.exitCode || (result.complete ? 0 : 1);
}
