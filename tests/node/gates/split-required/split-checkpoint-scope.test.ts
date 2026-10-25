import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { resolveSplitCheckpointTaskScope } from '../../../../src/gates/split-required/split-checkpoint-scope';

const PARENT_TASK_ID = 'T-CHECKPOINT';
const CHILD_TASK_ID = 'T-CHECKPOINT-2';

function git(repoRoot: string, args: string[]): string {
    return execFileSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
}

function createCheckpointRepo(): { repoRoot: string; checkpointCommit: string } {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-checkpoint-child-links-'));
    git(repoRoot, ['init']);
    git(repoRoot, ['config', 'user.email', 'test@example.invalid']);
    git(repoRoot, ['config', 'user.name', 'Test User']);
    git(repoRoot, ['config', 'core.autocrlf', 'false']);
    fs.mkdirSync(path.join(repoRoot, 'src'));
    fs.writeFileSync(path.join(repoRoot, '.gitignore'), 'TASK.md\n');
    fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const value = 1;\n');
    git(repoRoot, ['add', '.']);
    git(repoRoot, ['commit', '-m', 'initial']);
    fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const value = 2;\n');
    git(repoRoot, ['add', 'src/app.ts']);
    git(repoRoot, ['commit', '-m', `checkpoint(split): preserve ${PARENT_TASK_ID} dirty diff before decomposition`]);
    return { repoRoot, checkpointCommit: git(repoRoot, ['rev-parse', 'HEAD']) };
}

function writeTaskQueue(repoRoot: string, checkpointCommit: string, childLinks: string): void {
    fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
        '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
        '|---|---|---|---|---|---|---|---|---|',
        `| ${PARENT_TASK_ID} | DECOMPOSED | P1 | workflow | Parent | local | 2026-10-25 | balanced | Split checkpoint \`${checkpointCommit}\`. ${childLinks} |`,
        `| ${CHILD_TASK_ID} | TODO | P1 | workflow | Child | local | 2026-10-25 | balanced | Checkpoint: \`${checkpointCommit}\`. Checkpoint files: \`src/app.ts\`. |`,
        ''
    ].join('\n'), 'utf8');
}

describe('split checkpoint explicit child links', () => {
    it('accepts later explicit markers, aliases, and numeric ranges through scope resolution', (context) => {
        const { repoRoot, checkpointCommit } = createCheckpointRepo();
        context.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));

        for (const childLinks of [
            'Children: none. Child tasks: `T-CHECKPOINT-2`.',
            'Children: see `T-CHECKPOINT-1`. Children: `T-CHECKPOINT-2`.',
            'Children: `T-CHECKPOINT-2`.',
            'Children: T-CHECKPOINT-2.',
            'Child tasks: T-CHECKPOINT-2.',
            'Children: `T-CHECKPOINT-1` through `T-CHECKPOINT-3`.',
            'Child range T-CHECKPOINT-1 to T-CHECKPOINT-3.'
        ]) {
            writeTaskQueue(repoRoot, checkpointCommit, childLinks);

            const result = resolveSplitCheckpointTaskScope(repoRoot, CHILD_TASK_ID);

            assert.equal(result.violation, null, childLinks);
            assert.equal(result.scope?.parent_task_id, PARENT_TASK_ID, childLinks);
            assert.equal(result.scope?.checkpoint_commit, checkpointCommit, childLinks);
            assert.deepEqual(result.scope?.changed_files, ['src/app.ts'], childLinks);
        }
    });

    it('rejects prose references and exact-prefix lookalikes through scope resolution', (context) => {
        const { repoRoot, checkpointCommit } = createCheckpointRepo();
        context.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));

        for (const childLinks of [
            'No children: see `T-CHECKPOINT-2`.',
            'Children: see T-CHECKPOINT-1 through T-CHECKPOINT-3.',
            'Child tasks: see `T-CHECKPOINT-2`.',
            'Child tasks: `guide` and `T-CHECKPOINT-2`.',
            'Children: none. Child tasks: see `T-CHECKPOINT-2`.',
            'Children: `T-CHECKPOINT-20`.'
        ]) {
            writeTaskQueue(repoRoot, checkpointCommit, childLinks);

            const result = resolveSplitCheckpointTaskScope(repoRoot, CHILD_TASK_ID);

            assert.equal(result.scope, null, childLinks);
            assert.match(result.violation || '', /does not explicitly link split-checkpoint child/u, childLinks);
        }
    });
});
