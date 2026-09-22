import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { buildHelpText, COMMAND_SUMMARY } from '../../../../src/cli/commands/cli-helpers';
import { LIFECYCLE_COMMANDS } from '../../../../src/core/constants';

function findRepoRoot(): string {
    let current = path.resolve(process.cwd());
    while (true) {
        const packageJsonPath = path.join(current, 'package.json');
        const readmePath = path.join(current, 'README.md');
        const dispatcherPath = path.join(current, 'src', 'cli', 'commands', 'command-dispatch.ts');
        if (fs.existsSync(packageJsonPath) && fs.existsSync(readmePath) && fs.existsSync(dispatcherPath)) {
            return current;
        }
        const parent = path.dirname(current);
        if (parent === current) {
            throw new Error('Unable to resolve repository root for public command surface test.');
        }
        current = parent;
    }
}

const REPO_ROOT = findRepoRoot();
const DOCUMENTED_RUNTIME_EXCLUSIONS = new Map<string, string>([
    ['clean', 'documented through the public gc alias']
]);
const NON_LIFECYCLE_PUBLIC_COMMANDS = new Set<string>(['compact', 'gate', 'review-catalog']);

function readRepoText(relativePath: string): string {
    return fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');
}

function stripAnsi(text: string): string {
    return text.replace(/\x1B\[[0-9;]*m/g, '');
}

function sorted(values: Iterable<string>): string[] {
    return [...new Set(values)].sort();
}

function extractDispatcherCommands(): string[] {
    const source = readRepoText('src/cli/commands/command-dispatch.ts');
    return [...source.matchAll(/case '([^']+)':/g)].map((match) => match[1]);
}

function extractHelpCommands(): string[] {
    const helpText = stripAnsi(buildHelpText({ name: 'garda-agent-orchestrator', version: '1.0.0' }));
    const startMarker = 'Commands:\n';
    const endMarker = '\n\nGlobal options:';
    const startIndex = helpText.indexOf(startMarker);
    const endIndex = helpText.indexOf(endMarker);

    assert.notEqual(startIndex, -1, 'buildHelpText() must include a Commands section');
    assert.notEqual(endIndex, -1, 'buildHelpText() must include a Global options section');

    const section = helpText.slice(startIndex + startMarker.length, endIndex);
    return section
        .split('\n')
        .map((line) => line.match(/^  ([a-z][a-z-]*(?: [a-z][a-z-]*)?)\s{2,}/i)?.[1] ?? null)
        .filter((command): command is string => command !== null);
}

function extractReadmeCommands(): string[] {
    return [...readRepoText('README.md').matchAll(/^\| `garda(?: ([^`]+))?` \|/gm)]
        .map((match) => (match[1] || '').trim() || '(root)');
}

function extractCliReferenceCommands(): string[] {
    return [...readRepoText('docs/cli-reference.md').matchAll(/^### `garda(?: ([^`]+))?`/gm)]
        .map((match) => (match[1] || '').trim() || '(root)');
}

function getRuntimeRootForDocumentedCommand(command: string): string {
    if (command === 'debug env') {
        return 'debug';
    }
    if (command === 'update git') {
        return 'update';
    }
    return command.split(' ')[0];
}

test('dispatcher top-level commands match lifecycle inventory plus gate', () => {
    const dispatchCommands = new Set(extractDispatcherCommands().filter((command) => command !== 'help'));
    const expectedCommands = new Set([...LIFECYCLE_COMMANDS, ...NON_LIFECYCLE_PUBLIC_COMMANDS]);

    assert.deepEqual(
        sorted(dispatchCommands),
        sorted(expectedCommands),
        'dispatcher, lifecycle inventory, and explicit non-lifecycle public commands drifted'
    );
});

test('COMMAND_SUMMARY matches global help and stays backed by runtime inventory', () => {
    const summaryCommands = COMMAND_SUMMARY.map(([command]) => command);
    const helpCommands = extractHelpCommands();
    const dispatcherCommands = new Set(extractDispatcherCommands().filter((command) => command !== 'help'));
    const documentedRoots = new Set(summaryCommands.map(getRuntimeRootForDocumentedCommand));
    const lifecycleCommands = new Set(LIFECYCLE_COMMANDS);

    assert.deepEqual(
        sorted(helpCommands),
        sorted(summaryCommands),
        'global help and COMMAND_SUMMARY must describe the same public command surface'
    );

    for (const command of summaryCommands) {
        const runtimeRoot = getRuntimeRootForDocumentedCommand(command);
        assert.ok(
            dispatcherCommands.has(runtimeRoot),
            `documented command '${command}' is not backed by a dispatcher root command`
        );
    }

    const undocumentedLifecycleRoots = [...lifecycleCommands]
        .filter((command) => !documentedRoots.has(command));
    const undocumentedLifecycleExclusions = [...DOCUMENTED_RUNTIME_EXCLUSIONS.keys()];
    assert.deepEqual(
        sorted(undocumentedLifecycleRoots),
        sorted(undocumentedLifecycleExclusions),
        'only explicit runtime alias exclusions may be omitted from the documented command surface'
    );

    const nonLifecycleDocumentedRoots = [...documentedRoots]
        .filter((command) => !lifecycleCommands.has(command));
    assert.deepEqual(
        sorted(nonLifecycleDocumentedRoots),
        sorted(NON_LIFECYCLE_PUBLIC_COMMANDS),
        'only explicit non-lifecycle public commands may appear outside LIFECYCLE_COMMANDS'
    );
});

test('CLI reference documents the full COMMAND_SUMMARY surface', () => {
    const summaryCommands = COMMAND_SUMMARY.map(([command]) => command);
    const cliReferenceCommands = extractCliReferenceCommands().filter((command) => command !== '(root)');

    assert.deepEqual(
        sorted(cliReferenceCommands),
        sorted(summaryCommands),
        'docs/cli-reference.md must cover the full documented public command surface'
    );
});

test('README common-commands table stays valid and explicitly links to the full CLI reference', () => {
    const readmeText = readRepoText('README.md');
    const cliReferenceText = readRepoText('docs/cli-reference.md');
    const dispatcherCommands = new Set(extractDispatcherCommands().filter((command) => command !== 'help'));
    const summaryCommands = new Set(COMMAND_SUMMARY.map(([command]) => command));
    const readmeCommands = extractReadmeCommands();

    assert.match(
        readmeText,
        /Full reference:\s+\*\*\[docs\/cli-reference\.md\]\(docs\/cli-reference\.md\)\*\*/,
        'README common command table must explicitly point to the full CLI reference'
    );

    for (const command of readmeCommands) {
        if (command === '(root)') {
            continue;
        }
        const runtimeRoot = getRuntimeRootForDocumentedCommand(command);
        assert.ok(
            dispatcherCommands.has(runtimeRoot),
            `README command '${command}' is not backed by a dispatcher root command`
        );
        assert.ok(
            summaryCommands.has(command) || cliReferenceText.includes(`garda ${command}`),
            `README command '${command}' must stay documented in the full command reference`
        );
    }
});
