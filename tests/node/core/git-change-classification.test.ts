import { afterEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import * as gitHelpers from '../../../src/core/git-helpers';
import {
    GIT_EOL_CHANGE_POLICY,
    classifyGitChanges,
    selectGitChangeClassificationLayers
} from '../../../src/core/git-change-classification';
import { runGit } from '../../../src/core/git-helpers';
import { DEFAULT_GIT_TIMEOUT_MS } from '../../../src/core/subprocess';

const tempRoots: string[] = [];
const CONFLICT_STAGES_BY_STATUS = Object.freeze({
    DD: [1],
    AU: [2],
    UD: [1, 2],
    UA: [3],
    DU: [1, 3],
    AA: [2, 3],
    UU: [1, 2, 3]
} as const);

function makeRepo(autocrlf: 'false' | 'input' | 'true' = 'false', commit: boolean = true): string {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-git-change-classification-'));
    tempRoots.push(repoRoot);
    runGit(repoRoot, ['init']);
    runGit(repoRoot, ['config', 'user.email', 'tests@example.com']);
    runGit(repoRoot, ['config', 'user.name', 'Garda Tests']);
    runGit(repoRoot, ['config', 'core.autocrlf', autocrlf]);
    runGit(repoRoot, ['config', 'core.safecrlf', 'false']);
    fs.writeFileSync(path.join(repoRoot, 'tracked.txt'), 'alpha\nbeta\n', 'utf8');
    runGit(repoRoot, ['add', 'tracked.txt']);
    if (commit) runGit(repoRoot, ['commit', '-m', 'seed']);
    return repoRoot;
}

function findChange(
    repoRoot: string,
    layer: 'staged' | 'unstaged' | 'untracked',
    filePath: string = 'tracked.txt'
) {
    return classifyGitChanges(repoRoot).changes.find(
        (change) => change.layer === layer && change.path === filePath
    );
}

function writeGitBlob(repoRoot: string, label: string): string {
    const blobPath = path.join(repoRoot, '.git', `garda-${label}-blob.txt`);
    fs.writeFileSync(blobPath, `${label}\n`, 'utf8');
    try {
        return runGit(repoRoot, ['hash-object', '-w', blobPath]).trim();
    } finally {
        fs.rmSync(blobPath, { force: true });
    }
}

function configureUnmergedStatus(
    repoRoot: string,
    statusPair: keyof typeof CONFLICT_STAGES_BY_STATUS
): string {
    runGit(repoRoot, ['reset', '--hard', 'HEAD']);
    const filePath = `conflict-${statusPair}.txt`;
    fs.rmSync(path.join(repoRoot, filePath), { force: true });
    const stageBlobs = {
        1: writeGitBlob(repoRoot, `${statusPair}-base`),
        2: writeGitBlob(repoRoot, `${statusPair}-ours`),
        3: writeGitBlob(repoRoot, `${statusPair}-theirs`)
    };
    const conflictStages: readonly (1 | 2 | 3)[] = CONFLICT_STAGES_BY_STATUS[statusPair];
    const indexInfo = conflictStages
        .map((stage) => `100644 ${stageBlobs[stage]} ${stage}\t${filePath}`)
        .join('\n') + '\n';
    childProcess.execFileSync(
        'git',
        ['-C', repoRoot, 'update-index', '--index-info'],
        {
            input: indexInfo,
            stdio: ['pipe', 'pipe', 'pipe']
        }
    );
    const worktreeStage = conflictStages.includes(2)
        ? 2
        : conflictStages.includes(3)
            ? 3
            : null;
    if (worktreeStage !== null) {
        fs.writeFileSync(path.join(repoRoot, filePath), `${statusPair}-worktree-${worktreeStage}\n`, 'utf8');
    }
    return filePath;
}

function injectCompletedHeadTreeFailure(): { failure: Error; observedCommands: string[] } {
    const processModule = require('node:child_process') as typeof childProcess;
    const originalExec = processModule.execFileSync;
    const failure = Object.assign(new Error('HEAD tree query failed'), { status: 128 });
    const observedCommands: string[] = [];
    mock.method(processModule, 'execFileSync', (...args: Parameters<typeof childProcess.execFileSync>) => {
        const command = Array.isArray(args[1]) ? args[1][2] : undefined;
        if (command && ['ls-tree', 'symbolic-ref', 'show-ref'].includes(command)) {
            observedCommands.push(command);
        }
        if (command === 'ls-tree') throw failure;
        return Reflect.apply(originalExec, processModule, args);
    });
    return { failure, observedCommands };
}

describe('Git change classification', () => {
    afterEach(() => {
        mock.restoreAll();
        for (const tempRoot of tempRoots.splice(0)) {
            fs.rmSync(tempRoot, { recursive: true, force: true });
        }
    });

    it('preserves valid unborn HEAD as an empty committed tree', () => {
        const repoRoot = makeRepo('false', false);
        assert.deepEqual(classifyGitChanges(repoRoot).stagedFiles, ['tracked.txt']);
    });

    it('rejects corrupt HEAD instead of treating it as an unborn branch', () => {
        const repoRoot = makeRepo();
        const headRef = runGit(repoRoot, ['symbolic-ref', 'HEAD']).trim();
        fs.writeFileSync(path.join(repoRoot, '.git', headRef), `${'f'.repeat(40)}\n`);
        assert.throws(() => classifyGitChanges(repoRoot), /git .* failed:/);
    });

    it('rejects completed HEAD tree failures when the branch already exists', () => {
        const repoRoot = makeRepo();
        fs.writeFileSync(path.join(repoRoot, 'tracked.txt'), 'changed\n');
        runGit(repoRoot, ['add', 'tracked.txt']);
        const { failure, observedCommands } = injectCompletedHeadTreeFailure();
        assert.throws(() => classifyGitChanges(repoRoot),
            (error: unknown) => error instanceof Error && error.cause === failure);
        assert.deepEqual(observedCommands, ['ls-tree', 'symbolic-ref', 'show-ref']);
    });

    it('rejects completed HEAD tree failures for a detached HEAD', () => {
        const repoRoot = makeRepo();
        runGit(repoRoot, ['checkout', '--detach']);
        fs.writeFileSync(path.join(repoRoot, 'tracked.txt'), 'changed\n');
        runGit(repoRoot, ['add', 'tracked.txt']);
        const { failure, observedCommands } = injectCompletedHeadTreeFailure();
        assert.throws(() => classifyGitChanges(repoRoot),
            (error: unknown) => error instanceof Error && error.cause === failure);
        assert.deepEqual(observedCommands, ['ls-tree', 'symbolic-ref']);
    });

    it('rejects HEAD tree buffer errors instead of classifying an empty tree', () => {
        const repoRoot = makeRepo();
        fs.writeFileSync(path.join(repoRoot, 'tracked.txt'), 'changed\n');
        runGit(repoRoot, ['add', 'tracked.txt']);
        const processModule = require('node:child_process') as typeof childProcess;
        const originalExec = processModule.execFileSync;
        const failure = Object.assign(new Error('tree buffer exhausted'), { code: 'ENOBUFS', status: 1 });
        let attemptedHeadTree = false;
        mock.method(processModule, 'execFileSync', (...args: Parameters<typeof childProcess.execFileSync>) => {
            if (Array.isArray(args[1]) && args[1].includes('ls-tree')) {
                attemptedHeadTree = true;
                throw failure;
            }
            return Reflect.apply(originalExec, processModule, args);
        });
        assert.throws(() => classifyGitChanges(repoRoot),
            (error: unknown) => error instanceof Error && error.cause === failure);
        assert.equal(attemptedHeadTree, true);
    });

    it('rejects optional configuration transport errors instead of using defaults', () => {
        const repoRoot = makeRepo();
        const processModule = require('node:child_process') as typeof childProcess;
        const originalExec = processModule.execFileSync;
        const failure = Object.assign(new Error('configuration spawn failed'), { code: 'ENOENT', status: 1 });
        mock.method(processModule, 'execFileSync', (...args: Parameters<typeof childProcess.execFileSync>) => {
            if (Array.isArray(args[1]) && args[1].includes('--get-regexp')) throw failure;
            return Reflect.apply(originalExec, processModule, args);
        });
        assert.throws(() => classifyGitChanges(repoRoot),
            (error: unknown) => error instanceof Error && error.cause === failure);
    });

    it('applies the shared finite Git timeout when timeoutMs is omitted', () => {
        const observedTimeouts: Array<number | undefined> = [];
        const dateNowMock = mock.method(Date, 'now', () => 1_000);
        const runGitBinaryMock = mock.method(
            gitHelpers,
            'runGitBinary',
            ((...args: Parameters<typeof gitHelpers.runGitBinary>) => {
                observedTimeouts.push(args[2]?.timeoutMs);
                return Buffer.alloc(0);
            }) as typeof gitHelpers.runGitBinary
        );
        const runGitMock = mock.method(
            gitHelpers,
            'runGit',
            ((...args: Parameters<typeof gitHelpers.runGit>) => {
                observedTimeouts.push(args[2]?.timeoutMs);
                return '';
            }) as typeof gitHelpers.runGit
        );
        try {
            const result = classifyGitChanges('unused-mocked-repository');

            assert.deepEqual(result.changes, []);
            assert.deepEqual(observedTimeouts, [
                DEFAULT_GIT_TIMEOUT_MS,
                DEFAULT_GIT_TIMEOUT_MS,
                DEFAULT_GIT_TIMEOUT_MS
            ]);
        } finally {
            runGitMock.mock.restore();
            runGitBinaryMock.mock.restore();
            dateNowMock.mock.restore();
        }
    });

    it('keeps unstaged LF-to-CRLF-only changes in effective dirty scope', () => {
        const repoRoot = makeRepo();
        fs.writeFileSync(path.join(repoRoot, 'tracked.txt'), 'alpha\r\nbeta\r\n', 'utf8');

        const result = classifyGitChanges(repoRoot);
        const change = findChange(repoRoot, 'unstaged');

        assert.equal(result.policy, GIT_EOL_CHANGE_POLICY);
        assert.equal(change?.contentClassification, 'eol_only');
        assert.equal(change?.includedInEffectiveScope, true);
        assert.deepEqual(result.effectiveChangedFiles, ['tracked.txt']);
        assert.deepEqual(result.eolOnlyFiles, ['tracked.txt']);
        assert.match(change?.reason || '', /keeps the change in effective dirty scope/);
    });

    it('batches index and blob reads across many changed files', () => {
        const repoRoot = makeRepo();
        const fileNames = Array.from({ length: 12 }, (_, index) => `tracked-${index}.txt`);
        for (const fileName of fileNames) {
            fs.writeFileSync(path.join(repoRoot, fileName), `before ${fileName}\n`, 'utf8');
        }
        runGit(repoRoot, ['add', ...fileNames]);
        runGit(repoRoot, ['commit', '-m', 'add batching fixtures']);
        for (const fileName of fileNames) {
            fs.writeFileSync(path.join(repoRoot, fileName), `after ${fileName}\n`, 'utf8');
        }

        const commands: string[][] = [];
        const originalRunGitBinary = gitHelpers.runGitBinary;
        const runGitBinaryMock = mock.method(
            gitHelpers,
            'runGitBinary',
            ((...args: Parameters<typeof gitHelpers.runGitBinary>) => {
                commands.push([...args[1]]);
                return originalRunGitBinary(...args);
            }) as typeof gitHelpers.runGitBinary
        );
        try {
            const result = classifyGitChanges(repoRoot);
            assert.equal(result.unstagedFiles.length, fileNames.length);
        } finally {
            runGitBinaryMock.mock.restore();
        }

        assert.equal(commands.filter((args) => args[0] === 'ls-files' && args.includes('--stage')).length, 1);
        assert.equal(commands.filter((args) => args[0] === 'cat-file' && args[1] === '--batch-check').length, 1);
        assert.equal(commands.filter((args) => args[0] === 'cat-file' && args[1] === '--batch').length, 1);
        assert.equal(commands.filter((args) => args[0] === 'cat-file' && ['-s', 'blob'].includes(args[1])).length, 0);
    });

    it('preserves independent staged and unstaged classifications for one path', () => {
        const repoRoot = makeRepo();
        fs.writeFileSync(path.join(repoRoot, 'tracked.txt'), 'alpha\r\nbeta\r\n', 'utf8');
        runGit(repoRoot, ['add', 'tracked.txt']);
        fs.writeFileSync(path.join(repoRoot, 'tracked.txt'), 'alpha\r\nbeta changed\r\n', 'utf8');

        const result = classifyGitChanges(repoRoot);
        const staged = result.changes.find((change) => change.layer === 'staged');
        const unstaged = result.changes.find((change) => change.layer === 'unstaged');

        assert.equal(staged?.contentClassification, 'eol_only');
        assert.equal(unstaged?.contentClassification, 'content');
        assert.deepEqual(result.stagedFiles, ['tracked.txt']);
        assert.deepEqual(result.unstagedFiles, ['tracked.txt']);
    });

    it('projects canonical classifications by workflow layer without reclassifying content', () => {
        const repoRoot = makeRepo();
        fs.writeFileSync(path.join(repoRoot, 'tracked.txt'), 'alpha\r\nbeta\r\n', 'utf8');
        runGit(repoRoot, ['add', 'tracked.txt']);
        fs.writeFileSync(path.join(repoRoot, 'tracked.txt'), 'alpha\r\nchanged\r\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'new.txt'), 'new\n', 'utf8');

        const complete = classifyGitChanges(repoRoot);
        const stagedOnly = selectGitChangeClassificationLayers(complete, {
            layers: ['staged'],
            context: 'staged workflow scope'
        });
        const worktree = selectGitChangeClassificationLayers(complete, {
            layers: ['unstaged', 'untracked'],
            context: 'worktree workflow scope'
        });

        assert.deepEqual(stagedOnly.effectiveChangedFiles, ['tracked.txt']);
        assert.deepEqual(stagedOnly.stagedFiles, ['tracked.txt']);
        assert.deepEqual(stagedOnly.eolOnlyFiles, ['tracked.txt']);
        assert.deepEqual(worktree.effectiveChangedFiles, ['new.txt', 'tracked.txt']);
        assert.deepEqual(worktree.unstagedFiles, ['tracked.txt']);
        assert.deepEqual(worktree.untrackedFiles, ['new.txt']);
        assert.match(stagedOnly.audit.reason, /staged workflow scope selected 1 canonical Git layer change/);
    });

    it('classifies mixed EOL and text edits as content changes', () => {
        const repoRoot = makeRepo();
        fs.writeFileSync(path.join(repoRoot, 'tracked.txt'), 'alpha\r\nchanged\r\n', 'utf8');

        const change = findChange(repoRoot, 'unstaged');

        assert.equal(change?.contentClassification, 'content');
        assert.match(change?.reason || '', /still differs after line-ending normalization/);
    });

    it('treats adding a UTF-8 BOM as content instead of an EOL-only change', () => {
        const repoRoot = makeRepo();
        const withBom = Buffer.concat([
            Buffer.from([0xef, 0xbb, 0xbf]),
            Buffer.from('alpha\nbeta\n', 'utf8')
        ]);
        fs.writeFileSync(path.join(repoRoot, 'tracked.txt'), withBom);

        const change = findChange(repoRoot, 'unstaged');

        assert.equal(change?.contentClassification, 'content');
        assert.match(change?.reason || '', /still differs after line-ending normalization/);
    });

    it('never applies text EOL normalization to binary changes', () => {
        const repoRoot = makeRepo();
        fs.writeFileSync(path.join(repoRoot, 'binary.dat'), Buffer.from([0, 1, 2, 10]));
        runGit(repoRoot, ['add', 'binary.dat']);
        runGit(repoRoot, ['commit', '-m', 'add binary']);
        fs.writeFileSync(path.join(repoRoot, 'binary.dat'), Buffer.from([0, 1, 3, 13, 10]));

        const change = findChange(repoRoot, 'unstaged', 'binary.dat');

        assert.equal(change?.contentClassification, 'binary');
        assert.match(change?.reason || '', /binary or invalid UTF-8/);
    });

    it('reports untracked files separately without losing dirty scope', () => {
        const repoRoot = makeRepo();
        fs.writeFileSync(path.join(repoRoot, 'new.txt'), 'new\r\n', 'utf8');

        const result = classifyGitChanges(repoRoot);
        const change = findChange(repoRoot, 'untracked', 'new.txt');

        assert.equal(change?.changeKind, 'untracked');
        assert.equal(change?.contentClassification, 'content');
        assert.deepEqual(result.untrackedFiles, ['new.txt']);
        assert.deepEqual(result.effectiveChangedFiles, ['new.txt']);
    });

    it('adds an explicitly scoped ignored file without widening the default Git scope', () => {
        const repoRoot = makeRepo();
        fs.writeFileSync(path.join(repoRoot, '.gitignore'), 'ignored.txt\n', 'utf8');
        runGit(repoRoot, ['add', '.gitignore']);
        runGit(repoRoot, ['commit', '-m', 'ignore explicit fixture']);
        fs.writeFileSync(path.join(repoRoot, 'ignored.txt'), 'task owned\n', 'utf8');

        const commands: string[][] = [];
        const originalRunGitBinary = gitHelpers.runGitBinary;
        const runGitBinaryMock = mock.method(
            gitHelpers,
            'runGitBinary',
            ((...args: Parameters<typeof gitHelpers.runGitBinary>) => {
                commands.push([...args[1]]);
                return originalRunGitBinary(...args);
            }) as typeof gitHelpers.runGitBinary
        );
        let automatic: ReturnType<typeof classifyGitChanges>;
        let explicit: ReturnType<typeof classifyGitChanges>;
        try {
            automatic = classifyGitChanges(repoRoot);
            explicit = classifyGitChanges(repoRoot, {
                explicitUntrackedPaths: ['nested/../ignored.txt', '../outside.txt']
            });
        } finally {
            runGitBinaryMock.mock.restore();
        }

        assert.deepEqual(automatic.effectiveChangedFiles, []);
        assert.deepEqual(explicit.effectiveChangedFiles, ['ignored.txt']);
        assert.deepEqual(explicit.untrackedFiles, ['ignored.txt']);
        assert.equal(explicit.changes[0]?.contentClassification, 'content');
        assert.equal(commands.filter((args) => args[0] === 'ls-files' && args.includes('--stage')).length, 2);
        assert.equal(commands.filter((args) => args[0] === 'ls-files' && args.includes('--cached')).length, 0);
    });

    it('respects core.autocrlf=true normalization that Git itself considers clean', () => {
        const repoRoot = makeRepo('true');
        const trackedPath = path.join(repoRoot, 'tracked.txt');
        fs.rmSync(trackedPath);
        runGit(repoRoot, ['checkout', '--', 'tracked.txt']);

        const checkoutBytes = fs.readFileSync(trackedPath);
        const configBefore = runGit(repoRoot, ['config', '--local', '--list', '--null']);
        const result = classifyGitChanges(repoRoot);
        const configAfter = runGit(repoRoot, ['config', '--local', '--list', '--null']);

        assert.ok(checkoutBytes.includes(Buffer.from('\r\n')), 'autocrlf=true checkout should contain CRLF');
        assert.deepEqual(result.changes, []);
        assert.equal(result.gitConfig.autocrlf, 'true');
        assert.equal(result.audit.effectiveDirty, false);
        assert.match(result.audit.reason, /Git porcelain reported no effective changes/);
        assert.equal(configAfter, configBefore, 'classification must not mutate repository config');
    });

    it('keeps a porcelain-visible EOL-only change dirty under core.autocrlf=input', () => {
        const repoRoot = makeRepo('input');
        fs.writeFileSync(path.join(repoRoot, 'tracked.txt'), 'alpha\r\nbeta\r\n', 'utf8');

        const result = classifyGitChanges(repoRoot);
        const change = findChange(repoRoot, 'unstaged');

        assert.equal(change?.contentClassification, 'eol_only');
        assert.equal(result.audit.effectiveDirty, true);
        assert.deepEqual(result.effectiveChangedFiles, ['tracked.txt']);
        assert.equal(result.gitConfig.autocrlf, 'input');
    });

    it('classifies a pure rename with identical bytes as metadata', () => {
        const repoRoot = makeRepo();
        runGit(repoRoot, ['mv', 'tracked.txt', 'renamed.txt']);

        const change = findChange(repoRoot, 'staged', 'renamed.txt');

        assert.equal(change?.changeKind, 'renamed');
        assert.equal(change?.previousPath, 'tracked.txt');
        assert.equal(change?.contentClassification, 'metadata');
        assert.match(change?.reason || '', /bytes are identical/);
    });

    it('matches rename and copy scopes by current or previous path without widening scope', () => {
        const repoRoot = makeRepo();
        runGit(repoRoot, ['mv', 'tracked.txt', 'renamed.txt']);
        fs.writeFileSync(path.join(repoRoot, 'unrelated.txt'), 'unrelated\n', 'utf8');
        runGit(repoRoot, ['add', 'unrelated.txt']);

        const complete = classifyGitChanges(repoRoot);
        const renamedChange = complete.changes.find((change) => change.path === 'renamed.txt');
        const unrelatedChange = complete.changes.find((change) => change.path === 'unrelated.txt');
        assert.ok(renamedChange);
        assert.ok(unrelatedChange);

        for (const scopedPath of ['tracked.txt', 'renamed.txt']) {
            const selected = selectGitChangeClassificationLayers(complete, {
                layers: ['staged'],
                paths: [scopedPath],
                context: 'rename scope'
            });

            assert.deepEqual(
                selected.changes.map((change) => ({
                    path: change.path,
                    previousPath: change.previousPath,
                    changeKind: change.changeKind
                })),
                [{
                    path: 'renamed.txt',
                    previousPath: 'tracked.txt',
                    changeKind: 'renamed'
                }]
            );
        }

        const copyClassification = {
            ...complete,
            changes: [{
                ...renamedChange,
                path: 'copied.txt',
                status: 'C100',
                changeKind: 'copied' as const
            }, unrelatedChange]
        };
        for (const scopedPath of ['tracked.txt', 'copied.txt']) {
            const selected = selectGitChangeClassificationLayers(copyClassification, {
                layers: ['staged'],
                paths: [scopedPath],
                context: 'copy scope'
            });

            assert.deepEqual(
                selected.changes.map((change) => ({
                    path: change.path,
                    previousPath: change.previousPath,
                    changeKind: change.changeKind
                })),
                [{
                    path: 'copied.txt',
                    previousPath: 'tracked.txt',
                    changeKind: 'copied'
                }]
            );
        }
    });

    it('classifies every porcelain unmerged status pair in both conflict layers', () => {
        const repoRoot = makeRepo();

        for (const statusPair of Object.keys(CONFLICT_STAGES_BY_STATUS) as Array<
            keyof typeof CONFLICT_STAGES_BY_STATUS
        >) {
            const filePath = configureUnmergedStatus(repoRoot, statusPair);
            const result = classifyGitChanges(repoRoot);
            const conflicts = result.changes.filter((change) => change.path === filePath);

            assert.deepEqual(
                conflicts.map((change) => change.layer),
                ['staged', 'unstaged'],
                `${statusPair} must remain visible in both conflict layers`
            );
            assert.ok(conflicts.every((change) => change.status === statusPair));
            assert.ok(conflicts.every((change) => change.changeKind === 'unmerged'));
            assert.ok(conflicts.every((change) => change.contentClassification === 'metadata'));
            assert.ok(conflicts.every((change) => /unmerged/u.test(change.reason)));
            assert.deepEqual(result.effectiveChangedFiles, [filePath]);
        }
    });

    it('sorts paths by stable ordinal comparison', () => {
        const repoRoot = makeRepo();
        for (const fileName of ['a.txt', 'Z.txt', 'ä.txt']) {
            fs.writeFileSync(path.join(repoRoot, fileName), `${fileName}\n`, 'utf8');
        }

        const result = classifyGitChanges(repoRoot);

        assert.deepEqual(result.changes.map((change) => change.path), ['Z.txt', 'a.txt', 'ä.txt']);
        assert.deepEqual(result.untrackedFiles, ['Z.txt', 'a.txt', 'ä.txt']);
        assert.deepEqual(result.effectiveChangedFiles, ['Z.txt', 'a.txt', 'ä.txt']);
    });

    it('preserves a literal backslash in a POSIX Git pathname', {
        skip: process.platform === 'win32'
    }, () => {
        const repoRoot = makeRepo();
        const fileName = 'literal\\name.txt';
        fs.writeFileSync(path.join(repoRoot, fileName), 'before\n', 'utf8');
        runGit(repoRoot, ['add', '--', fileName]);
        runGit(repoRoot, ['commit', '-m', 'add literal backslash path']);
        fs.writeFileSync(path.join(repoRoot, fileName), 'after\n', 'utf8');

        const result = classifyGitChanges(repoRoot);
        const change = result.changes.find((entry) => entry.path === fileName);

        assert.equal(change?.layer, 'unstaged');
        assert.equal(change?.contentClassification, 'content');
        assert.deepEqual(result.effectiveChangedFiles, [fileName]);
    });
});
