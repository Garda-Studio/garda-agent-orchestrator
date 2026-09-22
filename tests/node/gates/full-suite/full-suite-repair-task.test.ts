import { afterEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import * as childProcess from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    materializeFullSuiteRepairTask,
    readFullSuiteRepairTaskMaterializationEvidence
} from '../../../../src/gates/full-suite/full-suite-repair-materialization';
import {
    restoreFullSuiteRepairWip
} from '../../../../src/gates/full-suite/full-suite-repair-task';
import {
    acquireFilesystemLock,
    releaseFilesystemLock
} from '../../../../src/gate-runtime/timeline/task-events-locking';

const TASK_ID = 'T-FULL-SUITE-REPAIR';
const CHILD_TASK_ID = `${TASK_ID}-F1`;
const SECOND_CHILD_TASK_ID = `${TASK_ID}-F2`;
const CHILD_TASK_IDS = [CHILD_TASK_ID, SECOND_CHILD_TASK_ID];

const tempRoots: string[] = [];

function runGit(repoRoot: string, args: string[]): string {
    return childProcess.execFileSync('git', ['-C', repoRoot, ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe']
    });
}

function writeJson(filePath: string, value: unknown): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function normalizeForArtifact(filePath: string): string {
    return filePath.replace(/\\/g, '/');
}

function normalizeNewlines(value: string): string {
    return value.replace(/\r\n/g, '\n');
}

function fileSha256(filePath: string): string {
    return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function seedTaskQueue(repoRoot: string): void {
    fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
        '# TASK.md',
        '',
        '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
        '|---|---|---|---|---|---|---|---|---|',
        `| ${TASK_ID} | IN_PROGRESS | P1 | workflow/full-suite | Parent repair task | gpt-5.5 | 2026-06-30 | strict | Decomposition source: orchestrator (2026-06-30); child tasks: \`${CHILD_TASK_ID}\`, \`${SECOND_CHILD_TASK_ID}\`. |`,
        `| ${CHILD_TASK_ID} | TODO | P1 | workflow/full-suite-timeout-diagnostics | Diagnose timeout blocker | gpt-5.5 | 2026-06-30 | strict | Child of \`${TASK_ID}\`. Repair scope paths: \`README.md\`; Identify the bounded timeout cause. |`,
        `| ${SECOND_CHILD_TASK_ID} | TODO | P1 | workflow/full-suite-timeout-repair | Repair timeout blocker | gpt-5.5 | 2026-06-30 | strict | Child of \`${TASK_ID}\`. Repair scope paths: \`src/repair-child-two.ts\`; Apply the independently scoped repair. |`,
        ''
    ].join('\n'), 'utf8');
}

function seedRepairArtifacts(repoRoot: string): { preflightPath: string; fullSuitePath: string } {
    const reviewsRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews');
    const preflightPath = path.join(reviewsRoot, `${TASK_ID}-preflight.json`);
    const fullSuitePath = path.join(reviewsRoot, `${TASK_ID}-full-suite-validation.json`);
    writeJson(preflightPath, {
        task_id: TASK_ID,
        status: 'PASSED',
        required_reviews: { code: true, test: true },
        changed_files: ['src/app.ts']
    });
    writeJson(fullSuitePath, {
        task_id: TASK_ID,
        status: 'FAILED',
        enabled: true,
        command: 'npm test',
        exit_code: 1,
        timed_out: true,
        timeout_policy: {
            timeout_blocker: true,
            timeout_retry_count: 1,
            max_attempts: 2,
            attempts: [
                { attempt: 1, exit_code: 1, timed_out: true },
                { attempt: 2, exit_code: 1, timed_out: true }
            ],
            attempts_exhausted: true,
            warning_only_continuation: false,
            repair_task_proposal: {
                suggested_task_id: CHILD_TASK_ID,
                title: 'Fix full-suite timeout blocker',
                area: 'workflow/full-suite-timeout',
                rationale: 'Full-suite validation timed out after configured retries.'
            }
        },
        output_artifact_path: normalizeForArtifact(path.join(reviewsRoot, `${TASK_ID}-full-suite-output.log`))
    });
    return { preflightPath, fullSuitePath };
}

function makeRepo(): { repoRoot: string; preflightPath: string; fullSuitePath: string } {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-full-suite-repair-'));
    tempRoots.push(repoRoot);
    fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, '.gitignore'), 'TASK.md\ngarda-agent-orchestrator/runtime/\n', 'utf8');
    fs.writeFileSync(path.join(repoRoot, 'README.md'), '# Fixture\n', 'utf8');
    fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const value = 1;\n', 'utf8');
    seedTaskQueue(repoRoot);

    childProcess.execFileSync('git', ['init', repoRoot], { stdio: 'ignore' });
    runGit(repoRoot, ['config', 'user.email', 'tests@example.com']);
    runGit(repoRoot, ['config', 'user.name', 'Garda Tests']);
    runGit(repoRoot, ['config', 'core.autocrlf', 'false']);
    runGit(repoRoot, ['add', '.gitignore', 'README.md', 'src/app.ts']);
    runGit(repoRoot, ['commit', '-m', 'seed']);
    return { repoRoot, ...seedRepairArtifacts(repoRoot) };
}

function readJson(filePath: string): Record<string, unknown> {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>;
}

function restoreMaterializedWip(params: {
    repoRoot: string;
    fullSuitePath: string;
    manifestPath: string;
    childTaskId?: string | null;
    dryRun?: boolean;
}) {
    return restoreFullSuiteRepairWip({
        repoRoot: params.repoRoot,
        taskId: TASK_ID,
        fullSuiteArtifactPath: params.fullSuitePath,
        manifestPath: params.manifestPath,
        childTaskId: params.childTaskId === undefined ? CHILD_TASK_ID : params.childTaskId,
        dryRun: params.dryRun
    });
}

function setTaskStatus(repoRoot: string, taskId: string, nextStatus: string): void {
    const taskPath = path.join(repoRoot, 'TASK.md');
    const content = fs.readFileSync(taskPath, 'utf8');
    let replaced = false;
    const lines = content.split('\n').map((line) => {
        if (!line.startsWith(`| ${taskId} |`)) {
            return line;
        }
        const cells = line.split('|');
        cells[2] = ` ${nextStatus} `;
        replaced = true;
        return cells.join('|');
    });
    assert.equal(replaced, true, `expected TASK.md row for ${taskId}`);
    fs.writeFileSync(taskPath, lines.join('\n'), 'utf8');
}

function markRepairChildDone(repoRoot: string): void {
    for (const childTaskId of CHILD_TASK_IDS) {
        setTaskStatus(repoRoot, childTaskId, 'DONE');
    }
}

function assertOperatorNextActionOutput(lines: string[], marker: string): void {
    assert.equal(lines[0], 'Next action:');
    assert.ok(lines.some((line) => line === marker), lines.join('\n'));
    assert.equal(lines.some((line) => line.startsWith('NextAction:')), false, lines.join('\n'));
}

function assertBlockedOperatorOutputHasNoNavigatorCommand(lines: string[]): void {
    assert.ok(lines.some((line) => line === '  Command: none'), lines.join('\n'));
    assert.ok(lines.some((line) => line.startsWith('  CommandReference:')), lines.join('\n'));
    assert.equal(
        lines.some((line) => line.startsWith('  Command: ') && line.includes(' next-step ')),
        false,
        lines.join('\n')
    );
}

function refreshMaterializationManifestSha(repoRoot: string, manifestPath: string): void {
    const artifactPath = path.join(
        repoRoot,
        'garda-agent-orchestrator',
        'runtime',
        'reviews',
        `${TASK_ID}-full-suite-repair-task.json`
    );
    const artifact = readJson(artifactPath);
    artifact.wip_manifest_sha256 = fileSha256(manifestPath);
    writeJson(artifactPath, artifact);
}

function getRepairCaptureParent(repoRoot: string): string {
    return path.join(
        repoRoot,
        'garda-agent-orchestrator',
        'runtime',
        'wip',
        TASK_ID,
        'full-suite-repair'
    );
}

function assertMaterializationControlPlaneRolledBack(repoRoot: string, originalTaskQueue: string): void {
    assert.equal(fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8'), originalTaskQueue);
    assert.equal(
        fs.existsSync(path.join(
            repoRoot,
            'garda-agent-orchestrator',
            'runtime',
            'reviews',
            `${TASK_ID}-split-required.json`
        )),
        false
    );
    const captureParent = getRepairCaptureParent(repoRoot);
    assert.deepEqual(fs.existsSync(captureParent) ? fs.readdirSync(captureParent) : [], []);
}

describe('full-suite repair task materialization', () => {
    afterEach(() => {
        for (const tempRoot of tempRoots.splice(0)) {
            fs.rmSync(tempRoot, { recursive: true, force: true });
        }
    });

    it('rejects a singular repair child before parent WIP is suspended', () => {
        const { repoRoot, preflightPath, fullSuitePath } = makeRepo();
        const taskPath = path.join(repoRoot, 'TASK.md');
        fs.writeFileSync(taskPath, [
            '# TASK.md',
            '',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            `| ${TASK_ID} | IN_PROGRESS | P1 | workflow/full-suite | Parent repair task | gpt-5.5 | 2026-06-30 | strict | Decomposition source: orchestrator (2026-06-30); child tasks: \`${CHILD_TASK_ID}\`. |`,
            `| ${CHILD_TASK_ID} | TODO | P1 | workflow/full-suite-timeout | Fix timeout blocker | gpt-5.5 | 2026-06-30 | strict | Child of \`${TASK_ID}\`. Repair scope paths: \`README.md\`; |`,
            ''
        ].join('\n'), 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const value = 2;\n', 'utf8');
        runGit(repoRoot, ['add', 'src/app.ts']);

        const materialized = materializeFullSuiteRepairTask({
            repoRoot,
            taskId: TASK_ID,
            preflightPath,
            fullSuiteArtifactPath: fullSuitePath
        });

        assert.equal(materialized.status, 'BLOCKED');
        assert.equal(materialized.wip_manifest_path, null);
        assert.deepEqual(materialized.child_task_ids, [CHILD_TASK_ID]);
        assert.ok(materialized.violations.some((violation) => violation.includes('requires at least two meaningful linked child tasks')));
        assert.match(fs.readFileSync(taskPath, 'utf8'), new RegExp(`\\| ${TASK_ID} \\| IN_PROGRESS \\|`));
        assert.match(runGit(repoRoot, ['diff', '--cached', '--', 'src/app.ts']), /\+export const value = 2;/);
    });

    it('rejects a repair proposal from a full-suite artifact that did not time out', () => {
        const { repoRoot, preflightPath, fullSuitePath } = makeRepo();
        const fullSuiteArtifact = readJson(fullSuitePath);
        fullSuiteArtifact.timed_out = false;
        writeJson(fullSuitePath, fullSuiteArtifact);
        const taskPath = path.join(repoRoot, 'TASK.md');
        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const value = 2;\n', 'utf8');
        runGit(repoRoot, ['add', 'src/app.ts']);

        const materialized = materializeFullSuiteRepairTask({
            repoRoot,
            taskId: TASK_ID,
            preflightPath,
            fullSuiteArtifactPath: fullSuitePath
        });

        assert.equal(materialized.status, 'BLOCKED');
        assert.equal(materialized.wip_manifest_path, null);
        assert.match(materialized.violations.join('\n'), /timed_out=true/);
        assert.match(fs.readFileSync(taskPath, 'utf8'), new RegExp(`\\| ${TASK_ID} \\| IN_PROGRESS \\|`));
        assert.match(runGit(repoRoot, ['diff', '--cached', '--', 'src/app.ts']), /\+export const value = 2;/);
    });

    it('rejects repair child scopes that overlap suspended parent WIP before mutation', () => {
        const { repoRoot, preflightPath, fullSuitePath } = makeRepo();
        const taskPath = path.join(repoRoot, 'TASK.md');
        fs.writeFileSync(
            taskPath,
            fs.readFileSync(taskPath, 'utf8').replace(
                'Repair scope paths: `README.md`;',
                'Repair scope paths: `src/app.ts`;'
            ),
            'utf8'
        );
        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const value = 2;\n', 'utf8');
        runGit(repoRoot, ['add', 'src/app.ts']);

        const materialized = materializeFullSuiteRepairTask({
            repoRoot,
            taskId: TASK_ID,
            preflightPath,
            fullSuiteArtifactPath: fullSuitePath
        });

        assert.equal(materialized.status, 'BLOCKED');
        assert.match(materialized.violations.join('\n'), /scope overlaps suspended parent WIP: src\/app\.ts/);
        assert.equal(materialized.wip_manifest_path, null);
        assert.match(runGit(repoRoot, ['diff', '--cached', '--', 'src/app.ts']), /\+export const value = 2;/);
    });

    it('suspends staged, unstaged, and task-owned ignored scratch, then restores them', () => {
        const { repoRoot, preflightPath, fullSuitePath } = makeRepo();
        const appPath = path.join(repoRoot, 'src', 'app.ts');
        fs.writeFileSync(appPath, 'export const value = 2;\n', 'utf8');
        runGit(repoRoot, ['add', 'src/app.ts']);
        fs.writeFileSync(appPath, 'export const value = 3;\n', 'utf8');

        const scratchPath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'tmp', `${TASK_ID}-scratch.log`);
        const reviewEvidencePath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews', `${TASK_ID}-extra-review-evidence.log`);
        fs.mkdirSync(path.dirname(scratchPath), { recursive: true });
        fs.mkdirSync(path.dirname(reviewEvidencePath), { recursive: true });
        fs.writeFileSync(scratchPath, 'scratch parent WIP\n', 'utf8');
        fs.writeFileSync(reviewEvidencePath, 'must remain gate evidence\n', 'utf8');

        const materialized = materializeFullSuiteRepairTask({
            repoRoot,
            taskId: TASK_ID,
            preflightPath,
            fullSuiteArtifactPath: fullSuitePath
        });

        assert.equal(materialized.status, 'MATERIALIZED', materialized.output_lines.join('\n'));
        assertOperatorNextActionOutput(materialized.output_lines, 'FULL_SUITE_REPAIR_TASK_MATERIALIZED');
        assert.ok(materialized.wip_manifest_path);
        assert.equal(normalizeNewlines(fs.readFileSync(appPath, 'utf8')), 'export const value = 1;\n');
        assert.equal(runGit(repoRoot, ['diff', '--name-only']).trim(), '');
        assert.equal(runGit(repoRoot, ['diff', '--name-only', '--cached']).trim(), '');
        assert.equal(fs.existsSync(scratchPath), false);
        assert.equal(fs.existsSync(reviewEvidencePath), true, 'review evidence must not be captured as WIP');

        const manifest = readJson(materialized.wip_manifest_path || '');
        assert.deepEqual(manifest.child_scopes, [
            { task_id: CHILD_TASK_ID, paths: ['README.md'] },
            { task_id: SECOND_CHILD_TASK_ID, paths: ['src/repair-child-two.ts'] }
        ]);
        const untrackedPaths = (manifest.untracked_files as Array<Record<string, unknown>>).map((entry) => entry.path);
        assert.deepEqual(untrackedPaths, ['garda-agent-orchestrator/runtime/tmp/T-FULL-SUITE-REPAIR-scratch.log']);
        assert.ok(fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8').includes(`| ${CHILD_TASK_ID} | TODO |`));
        assert.match(fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8'), new RegExp(`\\| ${TASK_ID} \\| .*SPLIT_REQUIRED .*\\|`));
        markRepairChildDone(repoRoot);

        const restored = restoreMaterializedWip({
            repoRoot,
            fullSuitePath,
            manifestPath: materialized.wip_manifest_path || ''
        });

        assert.equal(restored.status, 'RESTORED', restored.output_lines.join('\n'));
        assertOperatorNextActionOutput(restored.output_lines, 'FULL_SUITE_REPAIR_WIP_RESTORED');
        assert.equal(normalizeNewlines(fs.readFileSync(appPath, 'utf8')), 'export const value = 3;\n');
        assert.match(runGit(repoRoot, ['diff', '--cached', '--', 'src/app.ts']), /\+export const value = 2;/);
        assert.match(runGit(repoRoot, ['diff', '--', 'src/app.ts']), /[-]export const value = 2;[\s\S]*[+]export const value = 3;/);
        assert.equal(fs.readFileSync(scratchPath, 'utf8'), 'scratch parent WIP\n');
        assert.match(fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8'), new RegExp(`\\| ${TASK_ID} \\| .*IN_PROGRESS .*\\|`));
    });

    it('blocks restore before the linked repair child is DONE', () => {
        const { repoRoot, preflightPath, fullSuitePath } = makeRepo();
        const appPath = path.join(repoRoot, 'src', 'app.ts');
        fs.writeFileSync(appPath, 'export const value = 2;\n', 'utf8');
        runGit(repoRoot, ['add', 'src/app.ts']);
        const materialized = materializeFullSuiteRepairTask({
            repoRoot,
            taskId: TASK_ID,
            preflightPath,
            fullSuiteArtifactPath: fullSuitePath
        });

        const restored = restoreMaterializedWip({
            repoRoot,
            fullSuitePath,
            manifestPath: materialized.wip_manifest_path || ''
        });

        assert.equal(restored.status, 'BLOCKED');
        assertOperatorNextActionOutput(restored.output_lines, 'FULL_SUITE_REPAIR_WIP_RESTORE_BLOCKED');
        assertBlockedOperatorOutputHasNoNavigatorCommand(restored.output_lines);
        assert.ok(restored.violations.some((violation) => violation.includes(`repair child ${CHILD_TASK_ID} must be DONE`)));
        assert.equal(normalizeNewlines(fs.readFileSync(appPath, 'utf8')), 'export const value = 1;\n');
        assert.equal(runGit(repoRoot, ['diff', '--name-only']).trim(), '');
        assert.equal(runGit(repoRoot, ['diff', '--name-only', '--cached']).trim(), '');
    });

    it('blocks restore while any linked repair child remains unfinished', () => {
        const { repoRoot, preflightPath, fullSuitePath } = makeRepo();
        const appPath = path.join(repoRoot, 'src', 'app.ts');
        fs.writeFileSync(appPath, 'export const value = 2;\n', 'utf8');
        runGit(repoRoot, ['add', 'src/app.ts']);
        const materialized = materializeFullSuiteRepairTask({
            repoRoot,
            taskId: TASK_ID,
            preflightPath,
            fullSuiteArtifactPath: fullSuitePath
        });
        assert.equal(materialized.status, 'MATERIALIZED', materialized.output_lines.join('\n'));
        setTaskStatus(repoRoot, CHILD_TASK_ID, 'DONE');

        const restored = restoreMaterializedWip({
            repoRoot,
            fullSuitePath,
            manifestPath: materialized.wip_manifest_path || ''
        });

        assert.equal(restored.status, 'BLOCKED');
        assertOperatorNextActionOutput(restored.output_lines, 'FULL_SUITE_REPAIR_WIP_RESTORE_BLOCKED');
        assertBlockedOperatorOutputHasNoNavigatorCommand(restored.output_lines);
        assert.ok(restored.violations.some((violation) => violation.includes(`repair child ${SECOND_CHILD_TASK_ID} must be DONE`)));
        assert.equal(normalizeNewlines(fs.readFileSync(appPath, 'utf8')), 'export const value = 1;\n');
        assert.equal(runGit(repoRoot, ['diff', '--name-only']).trim(), '');
        assert.equal(runGit(repoRoot, ['diff', '--name-only', '--cached']).trim(), '');
    });

    it('blocks restore when the repair decomposition changes before WIP mutation', () => {
        const { repoRoot, preflightPath, fullSuitePath } = makeRepo();
        const taskPath = path.resolve(repoRoot, 'TASK.md');
        const statusLockPath = `${taskPath}.garda-status-sync.lock`;
        const appPath = path.join(repoRoot, 'src', 'app.ts');
        fs.writeFileSync(appPath, 'export const value = 2;\n', 'utf8');
        runGit(repoRoot, ['add', 'src/app.ts']);
        const materialized = materializeFullSuiteRepairTask({
            repoRoot,
            taskId: TASK_ID,
            preflightPath,
            fullSuiteArtifactPath: fullSuitePath
        });
        assert.equal(materialized.status, 'MATERIALIZED', materialized.output_lines.join('\n'));
        markRepairChildDone(repoRoot);

        const fsModule = require('node:fs') as typeof import('node:fs');
        const originalMkdirSync = fsModule.mkdirSync;
        let injected = false;
        fsModule.mkdirSync = ((filePath: fs.PathLike, options?: fs.MakeDirectoryOptions) => {
            if (!injected
                && path.resolve(String(filePath)) === statusLockPath) {
                injected = true;
                const driftedTaskQueue = fs.readFileSync(taskPath, 'utf8')
                    .replace(`, \`${SECOND_CHILD_TASK_ID}\``, '');
                fs.writeFileSync(taskPath, driftedTaskQueue, 'utf8');
            }
            return Reflect.apply(originalMkdirSync, fsModule, [filePath, options]);
        }) as typeof fsModule.mkdirSync;
        let restored: ReturnType<typeof restoreMaterializedWip> | null = null;
        try {
            restored = restoreMaterializedWip({
                repoRoot,
                fullSuitePath,
                manifestPath: materialized.wip_manifest_path || ''
            });
        } finally {
            fsModule.mkdirSync = originalMkdirSync;
        }

        assert.equal(injected, true);
        assert.equal(restored?.status, 'BLOCKED');
        assert.ok(
            restored?.violations.some((violation) => violation.includes('repair handoff changed before WIP restore')),
            restored?.violations.join('\n')
        );
        assert.equal(normalizeNewlines(fs.readFileSync(appPath, 'utf8')), 'export const value = 1;\n');
        assert.equal(runGit(repoRoot, ['diff', '--name-only']).trim(), '');
        assert.equal(runGit(repoRoot, ['diff', '--name-only', '--cached']).trim(), '');
    });

    it('blocks restore when materialization evidence changes before WIP mutation', () => {
        const { repoRoot, preflightPath, fullSuitePath } = makeRepo();
        const taskPath = path.resolve(repoRoot, 'TASK.md');
        const statusLockPath = `${taskPath}.garda-status-sync.lock`;
        const appPath = path.join(repoRoot, 'src', 'app.ts');
        fs.writeFileSync(appPath, 'export const value = 2;\n', 'utf8');
        runGit(repoRoot, ['add', 'src/app.ts']);
        const materialized = materializeFullSuiteRepairTask({
            repoRoot,
            taskId: TASK_ID,
            preflightPath,
            fullSuiteArtifactPath: fullSuitePath
        });
        assert.equal(materialized.status, 'MATERIALIZED', materialized.output_lines.join('\n'));
        markRepairChildDone(repoRoot);

        const fsModule = require('node:fs') as typeof import('node:fs');
        const originalMkdirSync = fsModule.mkdirSync;
        let injected = false;
        fsModule.mkdirSync = ((filePath: fs.PathLike, options?: fs.MakeDirectoryOptions) => {
            if (!injected
                && path.resolve(String(filePath)) === statusLockPath) {
                injected = true;
                const artifact = readJson(materialized.artifact_path);
                artifact.status = 'BLOCKED';
                fs.writeFileSync(materialized.artifact_path, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
            }
            return Reflect.apply(originalMkdirSync, fsModule, [filePath, options]);
        }) as typeof fsModule.mkdirSync;
        let restored: ReturnType<typeof restoreMaterializedWip> | null = null;
        try {
            restored = restoreMaterializedWip({
                repoRoot,
                fullSuitePath,
                manifestPath: materialized.wip_manifest_path || ''
            });
        } finally {
            fsModule.mkdirSync = originalMkdirSync;
        }

        assert.equal(injected, true);
        assert.equal(restored?.status, 'BLOCKED');
        assert.ok(
            restored?.violations.some((violation) => violation.includes('repair handoff changed before WIP restore')),
            restored?.violations.join('\n')
        );
        assert.equal(normalizeNewlines(fs.readFileSync(appPath, 'utf8')), 'export const value = 1;\n');
        assert.equal(runGit(repoRoot, ['diff', '--name-only']).trim(), '');
        assert.equal(runGit(repoRoot, ['diff', '--name-only', '--cached']).trim(), '');
    });

    it('blocks a second restore caller while the manifest restore lock is held', () => {
        const { repoRoot, preflightPath, fullSuitePath } = makeRepo();
        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const value = 2;\n', 'utf8');
        runGit(repoRoot, ['add', 'src/app.ts']);
        const materialized = materializeFullSuiteRepairTask({
            repoRoot,
            taskId: TASK_ID,
            preflightPath,
            fullSuiteArtifactPath: fullSuitePath
        });
        assert.equal(materialized.status, 'MATERIALIZED', materialized.output_lines.join('\n'));
        markRepairChildDone(repoRoot);
        const manifestPath = materialized.wip_manifest_path || '';
        const { handle } = acquireFilesystemLock(`${manifestPath}.restore.lock`, {
            ownerLabel: 'full-suite-repair-test-holder'
        });
        try {
            const restored = restoreMaterializedWip({
                repoRoot,
                fullSuitePath,
                manifestPath
            });
            assert.equal(restored.status, 'BLOCKED');
            assert.ok(restored.violations.some((violation) => violation.includes('restore lock acquisition failed')));
            assert.equal(runGit(repoRoot, ['diff', '--name-only', '--cached']).trim(), '');
        } finally {
            releaseFilesystemLock(handle);
        }
    });

    it('blocks a concurrent process while the task transaction lock is held', async () => {
        const { repoRoot, preflightPath, fullSuitePath } = makeRepo();
        const taskPath = path.join(repoRoot, 'TASK.md');
        const originalTaskQueue = fs.readFileSync(taskPath, 'utf8');
        const appPath = path.join(repoRoot, 'src', 'app.ts');
        fs.writeFileSync(appPath, 'export const value = 2;\n', 'utf8');
        runGit(repoRoot, ['add', 'src/app.ts']);
        const lockKey = createHash('sha256').update(TASK_ID).digest('hex').slice(0, 32);
        const lockPath = path.join(
            repoRoot,
            'garda-agent-orchestrator',
            'runtime',
            'locks',
            'full-suite-repair-task',
            `${lockKey}.lock`
        );
        const holderScript = [
            "const fs = require('node:fs');",
            "const os = require('node:os');",
            "const path = require('node:path');",
            'const lockPath = process.argv[1];',
            'fs.mkdirSync(path.dirname(lockPath), { recursive: true });',
            'fs.mkdirSync(lockPath);',
            'const now = new Date().toISOString();',
            "fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({",
            "  lock_id: 'interprocess-test-holder',",
            '  pid: process.pid,',
            '  hostname: os.hostname(),',
            '  created_at_utc: now,',
            '  heartbeat_at_utc: now,',
            "  command: 'full-suite-repair-materialization-test-holder'",
            "}, null, 2) + '\\n');",
            "process.stdout.write('READY\\n');",
            'setInterval(() => {}, 1000);'
        ].join('\n');
        const holder = childProcess.spawn(process.execPath, ['-e', holderScript, lockPath], {
            stdio: ['ignore', 'pipe', 'pipe']
        });
        const holderClosed = new Promise<void>((resolve) => {
            holder.once('close', () => resolve());
        });
        const holderReady = new Promise<void>((resolve, reject) => {
            let stderr = '';
            const timeout = setTimeout(() => {
                reject(new Error(`interprocess lock holder did not become ready: ${stderr}`));
            }, 5000);
            holder.stderr.setEncoding('utf8');
            holder.stderr.on('data', (chunk: string) => {
                stderr += chunk;
            });
            holder.once('error', (error) => {
                clearTimeout(timeout);
                reject(error);
            });
            holder.stdout.setEncoding('utf8');
            holder.stdout.once('data', (chunk: string) => {
                if (!chunk.includes('READY')) {
                    clearTimeout(timeout);
                    reject(new Error(`unexpected interprocess lock holder output: ${chunk}`));
                    return;
                }
                clearTimeout(timeout);
                resolve();
            });
        });
        try {
            await holderReady;
            const materialized = materializeFullSuiteRepairTask({
                repoRoot,
                taskId: TASK_ID,
                preflightPath,
                fullSuiteArtifactPath: fullSuitePath
            });

            assert.equal(materialized.status, 'BLOCKED');
            assert.equal(materialized.child_task_id, null);
            assert.ok(materialized.violations.some((violation) => violation.includes('materialization lock acquisition failed')));
            assert.equal(fs.readFileSync(taskPath, 'utf8'), originalTaskQueue);
            assert.equal(fs.readFileSync(appPath, 'utf8'), 'export const value = 2;\n');
            assert.match(runGit(repoRoot, ['diff', '--cached', '--', 'src/app.ts']), /\+export const value = 2;/);
            assert.deepEqual(
                fs.existsSync(getRepairCaptureParent(repoRoot))
                    ? fs.readdirSync(getRepairCaptureParent(repoRoot))
                    : [],
                []
            );
            assert.equal(fs.existsSync(path.join(
                repoRoot,
                'garda-agent-orchestrator',
                'runtime',
                'reviews',
                `${TASK_ID}-split-required.json`
            )), false);
            assert.equal(fs.existsSync(materialized.artifact_path), false);
        } finally {
            if (holder.exitCode === null) {
                holder.kill();
            }
            await holderClosed;
            holder.stdout.destroy();
            holder.stderr.destroy();
            holder.unref();
        }
    });

    it('blocks a manifest-derived restore lock path through a symbolic-link or junction ancestor', () => {
        const { repoRoot, fullSuitePath } = makeRepo();
        const externalRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-full-suite-lock-external-'));
        tempRoots.push(externalRoot);
        const externalManifestPath = path.join(externalRoot, 'manifest.json');
        writeJson(externalManifestPath, { kind: 'full_suite_repair_wip' });
        const linkPath = path.join(repoRoot, 'manifest-link');
        fs.symlinkSync(externalRoot, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
        const linkedManifestPath = path.join(linkPath, 'manifest.json');

        const restored = restoreMaterializedWip({
            repoRoot,
            fullSuitePath,
            manifestPath: linkedManifestPath
        });

        assert.equal(restored.status, 'BLOCKED');
        assert.ok(restored.violations.some((violation) => violation.includes('restore lock containment failed')));
        assert.equal(fs.existsSync(`${externalManifestPath}.restore.lock`), false);
    });

    it('blocks materialization when tracked changes include files outside the preflight scope', () => {
        const { repoRoot, preflightPath, fullSuitePath } = makeRepo();
        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const value = 2;\n', 'utf8');
        runGit(repoRoot, ['add', 'src/app.ts']);
        fs.writeFileSync(path.join(repoRoot, 'README.md'), '# Fixture\n\nunrelated\n', 'utf8');

        const materialized = materializeFullSuiteRepairTask({
            repoRoot,
            taskId: TASK_ID,
            preflightPath,
            fullSuiteArtifactPath: fullSuitePath
        });

        assert.equal(materialized.status, 'BLOCKED');
        assertOperatorNextActionOutput(materialized.output_lines, 'FULL_SUITE_REPAIR_TASK_BLOCKED');
        assertBlockedOperatorOutputHasNoNavigatorCommand(materialized.output_lines);
        assert.equal(materialized.wip_manifest_path, null);
        assert.equal(materialized.split_required_artifact_path, null);
        assert.ok(materialized.violations.some((violation) => violation.includes('tracked changes outside current preflight scope: README.md')));
        assert.equal(runGit(repoRoot, ['diff', '--name-only']).trim(), 'README.md');
        assert.equal(runGit(repoRoot, ['diff', '--name-only', '--cached']).trim(), 'src/app.ts');
        assert.match(fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8'), new RegExp(`\\| ${TASK_ID} \\| IN_PROGRESS \\|`));
    });

    it('blocks materialization when unrelated visible untracked files would dirty the repair scope', () => {
        const { repoRoot, preflightPath, fullSuitePath } = makeRepo();
        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const value = 2;\n', 'utf8');
        runGit(repoRoot, ['add', 'src/app.ts']);
        fs.writeFileSync(path.join(repoRoot, 'unrelated-notes.txt'), 'operator scratch\n', 'utf8');

        const materialized = materializeFullSuiteRepairTask({
            repoRoot,
            taskId: TASK_ID,
            preflightPath,
            fullSuiteArtifactPath: fullSuitePath
        });

        assert.equal(materialized.status, 'BLOCKED');
        assert.equal(materialized.wip_manifest_path, null);
        assert.ok(materialized.violations.some((violation) => violation.includes('unrelated untracked files would keep repair scope dirty: unrelated-notes.txt')));
        assert.equal(fs.readFileSync(path.join(repoRoot, 'unrelated-notes.txt'), 'utf8'), 'operator scratch\n');
        assert.equal(runGit(repoRoot, ['status', '--short', '--untracked-files=all']).includes('?? unrelated-notes.txt'), true);
        assert.match(fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8'), new RegExp(`\\| ${TASK_ID} \\| IN_PROGRESS \\|`));
    });

    it('blocks task-id untracked files outside the captured runtime tmp and preflight scopes', () => {
        const { repoRoot, preflightPath, fullSuitePath } = makeRepo();
        const scratchPath = path.join(repoRoot, 'scratch', TASK_ID, 'notes.txt');
        fs.mkdirSync(path.dirname(scratchPath), { recursive: true });
        fs.writeFileSync(scratchPath, 'operator scratch outside capture roots\n', 'utf8');

        const materialized = materializeFullSuiteRepairTask({
            repoRoot,
            taskId: TASK_ID,
            preflightPath,
            fullSuiteArtifactPath: fullSuitePath
        });

        assert.equal(materialized.status, 'BLOCKED');
        assert.equal(materialized.wip_manifest_path, null);
        assert.ok(materialized.violations.some((violation) => violation.includes('scratch/T-FULL-SUITE-REPAIR/notes.txt')));
        assert.equal(fs.readFileSync(scratchPath, 'utf8'), 'operator scratch outside capture roots\n');
        assert.equal(runGit(repoRoot, ['status', '--short', '--untracked-files=all']).includes('?? scratch/T-FULL-SUITE-REPAIR/notes.txt'), true);
    });

    it('blocks a preflight-authorized untracked symlink or junction before capture', () => {
        const { repoRoot, preflightPath, fullSuitePath } = makeRepo();
        const externalRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-full-suite-capture-external-'));
        tempRoots.push(externalRoot);
        const externalPath = path.join(externalRoot, 'external.ts');
        const linkPath = path.join(repoRoot, 'src', 'external-link');
        fs.writeFileSync(externalPath, 'external secret must not be captured\n', 'utf8');
        fs.symlinkSync(externalRoot, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
        const preflight = readJson(preflightPath);
        preflight.changed_files = ['src/app.ts', 'src/external-link/external.ts'];
        writeJson(preflightPath, preflight);

        const materialized = materializeFullSuiteRepairTask({
            repoRoot,
            taskId: TASK_ID,
            preflightPath,
            fullSuiteArtifactPath: fullSuitePath
        });

        assert.equal(materialized.status, 'BLOCKED');
        assert.equal(materialized.wip_manifest_path, null);
        assert.ok(materialized.violations.some((violation) => violation.includes('symbolic-link or junction')));
        assert.equal(fs.readFileSync(externalPath, 'utf8'), 'external secret must not be captured\n');
        assert.match(fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8'), new RegExp(`\\| ${TASK_ID} \\| IN_PROGRESS \\|`));
    });

    it('blocks a preflight-authorized untracked hard link before capture', (t) => {
        const { repoRoot, preflightPath, fullSuitePath } = makeRepo();
        const externalRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-full-suite-capture-hardlink-'));
        tempRoots.push(externalRoot);
        const externalPath = path.join(externalRoot, 'external.ts');
        const linkPath = path.join(repoRoot, 'src', 'external-hardlink.ts');
        fs.writeFileSync(externalPath, 'hard-linked external content\n', 'utf8');
        try {
            fs.linkSync(externalPath, linkPath);
        } catch (error: unknown) {
            t.skip(`hard-link creation unavailable: ${error instanceof Error ? error.message : String(error)}`);
            return;
        }
        const preflight = readJson(preflightPath);
        preflight.changed_files = ['src/app.ts', 'src/external-hardlink.ts'];
        writeJson(preflightPath, preflight);

        const materialized = materializeFullSuiteRepairTask({
            repoRoot,
            taskId: TASK_ID,
            preflightPath,
            fullSuiteArtifactPath: fullSuitePath
        });

        assert.equal(materialized.status, 'BLOCKED');
        assert.equal(materialized.wip_manifest_path, null);
        assert.ok(materialized.violations.some((violation) => violation.includes('additional hard links')));
        assert.equal(fs.readFileSync(externalPath, 'utf8'), 'hard-linked external content\n');
        assert.match(fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8'), new RegExp(`\\| ${TASK_ID} \\| IN_PROGRESS \\|`));
    });

    it('cleans prepared capture and leaves TASK.md unchanged on a post-copy source failure', () => {
        const { repoRoot, preflightPath, fullSuitePath } = makeRepo();
        const relativePath = 'src/post-copy-helper.ts';
        const helperPath = path.join(repoRoot, relativePath);
        fs.writeFileSync(helperPath, 'export const beforeCopy = true;\n', 'utf8');
        const preflight = readJson(preflightPath);
        preflight.changed_files = ['src/app.ts', relativePath];
        writeJson(preflightPath, preflight);

        const fsModule = require('node:fs') as typeof import('node:fs');
        const originalCopyFileSync = fsModule.copyFileSync;
        let injectedPostCopyChange = false;
        fsModule.copyFileSync = ((source: fs.PathLike, destination: fs.PathLike, mode?: number) => {
            originalCopyFileSync(source, destination, mode);
            if (!injectedPostCopyChange && path.resolve(String(source)) === path.resolve(helperPath)) {
                injectedPostCopyChange = true;
                fs.appendFileSync(helperPath, 'export const changedAfterCopy = true;\n', 'utf8');
            }
        }) as typeof fsModule.copyFileSync;
        let materialized: ReturnType<typeof materializeFullSuiteRepairTask> | null = null;
        try {
            materialized = materializeFullSuiteRepairTask({
                repoRoot,
                taskId: TASK_ID,
                preflightPath,
                fullSuiteArtifactPath: fullSuitePath
            });
        } finally {
            fsModule.copyFileSync = originalCopyFileSync;
        }

        assert.equal(injectedPostCopyChange, true);
        assert.equal(materialized?.status, 'BLOCKED');
        assert.equal(materialized?.wip_manifest_path, null);
        assert.ok(materialized?.violations.some((violation) => violation.includes('changed while copying')));
        const taskContent = fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8');
        assert.match(taskContent, new RegExp(`\\| ${TASK_ID} \\| IN_PROGRESS \\|`));
        assert.ok(taskContent.includes(`| ${CHILD_TASK_ID} | TODO |`));
        const captureParent = path.join(
            repoRoot,
            'garda-agent-orchestrator',
            'runtime',
            'wip',
            TASK_ID,
            'full-suite-repair'
        );
        assert.deepEqual(fs.existsSync(captureParent) ? fs.readdirSync(captureParent) : [], []);
    });

    it('refuses a pre-existing capture leaf without deleting it', () => {
        const { repoRoot, preflightPath, fullSuitePath } = makeRepo();
        const originalTaskQueue = fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const value = 2;\n', 'utf8');
        runGit(repoRoot, ['add', 'src/app.ts']);

        const fsModule = require('node:fs') as typeof import('node:fs');
        const originalMkdirSync = fsModule.mkdirSync;
        const originalWriteFileSync = fsModule.writeFileSync;
        let collisionRoot = '';
        fsModule.mkdirSync = ((directoryPath: fs.PathLike, options?: fs.MakeDirectoryOptions & { recursive?: boolean }) => {
            const candidate = path.resolve(String(directoryPath));
            const parent = path.dirname(candidate);
            if (!collisionRoot
                && path.basename(parent) === 'full-suite-repair'
                && normalizeForArtifact(parent).includes(`/runtime/wip/${TASK_ID}/`)) {
                collisionRoot = candidate;
                originalMkdirSync(candidate);
                originalWriteFileSync(path.join(candidate, 'sentinel.txt'), 'must survive collision\n', 'utf8');
            }
            return originalMkdirSync(directoryPath, options as fs.MakeDirectoryOptions);
        }) as typeof fsModule.mkdirSync;
        let materialized: ReturnType<typeof materializeFullSuiteRepairTask> | null = null;
        try {
            materialized = materializeFullSuiteRepairTask({
                repoRoot,
                taskId: TASK_ID,
                preflightPath,
                fullSuiteArtifactPath: fullSuitePath
            });
        } finally {
            fsModule.mkdirSync = originalMkdirSync;
        }

        assert.equal(materialized?.status, 'BLOCKED');
        assert.ok(materialized?.violations.some((violation) => violation.includes('WIP capture preparation failed')));
        assert.ok(collisionRoot);
        assert.equal(fs.readFileSync(path.join(collisionRoot, 'sentinel.txt'), 'utf8'), 'must survive collision\n');
        assert.equal(fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8'), originalTaskQueue);
    });

    it('blocks when a captured patch is replaced before post-prepare verification', () => {
        const { repoRoot, preflightPath, fullSuitePath } = makeRepo();
        const originalTaskQueue = fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const value = 2;\n', 'utf8');
        runGit(repoRoot, ['add', 'src/app.ts']);

        const fsModule = require('node:fs') as typeof import('node:fs');
        const originalOpenSync = fsModule.openSync;
        const originalWriteFileSync = fsModule.writeFileSync;
        let stagedPatchOpenCount = 0;
        let replaced = false;
        fsModule.openSync = ((filePath: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
            const candidate = path.resolve(String(filePath));
            if (path.basename(candidate) === 'staged.patch'
                && normalizeForArtifact(candidate).includes(`/runtime/wip/${TASK_ID}/full-suite-repair/`)) {
                stagedPatchOpenCount += 1;
                if (stagedPatchOpenCount === 2) {
                    originalWriteFileSync(candidate, 'forged patch\n', 'utf8');
                    replaced = true;
                }
            }
            return originalOpenSync(filePath, flags, mode);
        }) as typeof fsModule.openSync;
        let materialized: ReturnType<typeof materializeFullSuiteRepairTask> | null = null;
        try {
            materialized = materializeFullSuiteRepairTask({
                repoRoot,
                taskId: TASK_ID,
                preflightPath,
                fullSuiteArtifactPath: fullSuitePath
            });
        } finally {
            fsModule.openSync = originalOpenSync;
        }

        assert.equal(replaced, true);
        assert.equal(materialized?.status, 'BLOCKED');
        assert.ok(materialized?.violations.some((violation) => (
            violation.includes('captured staged WIP patch changed after exclusive creation')
            || violation.includes('captured staged WIP patch sha256 mismatch')
        )));
        assert.equal(fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8'), originalTaskQueue);
        const captureParent = getRepairCaptureParent(repoRoot);
        assert.deepEqual(fs.existsSync(captureParent) ? fs.readdirSync(captureParent) : [], []);
    });

    it('prepends operator next action blocks for already-materialized and dry-run outputs', () => {
        const { repoRoot, preflightPath, fullSuitePath } = makeRepo();
        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const value = 2;\n', 'utf8');
        runGit(repoRoot, ['add', 'src/app.ts']);
        const materialized = materializeFullSuiteRepairTask({
            repoRoot,
            taskId: TASK_ID,
            preflightPath,
            fullSuiteArtifactPath: fullSuitePath
        });
        assert.equal(materialized.status, 'MATERIALIZED', materialized.output_lines.join('\n'));

        const alreadyMaterialized = materializeFullSuiteRepairTask({
            repoRoot,
            taskId: TASK_ID,
            preflightPath,
            fullSuiteArtifactPath: fullSuitePath
        });
        assert.equal(alreadyMaterialized.status, 'ALREADY_MATERIALIZED', alreadyMaterialized.output_lines.join('\n'));
        assertOperatorNextActionOutput(alreadyMaterialized.output_lines, 'FULL_SUITE_REPAIR_TASK_ALREADY_MATERIALIZED');

        markRepairChildDone(repoRoot);
        const dryRun = restoreMaterializedWip({
            repoRoot,
            fullSuitePath,
            manifestPath: materialized.wip_manifest_path || '',
            dryRun: true
        });
        assert.equal(dryRun.status, 'DRY_RUN_OK', dryRun.output_lines.join('\n'));
        assertOperatorNextActionOutput(dryRun.output_lines, 'FULL_SUITE_REPAIR_WIP_RESTORE_DRY_RUN_OK');
        assert.ok(dryRun.output_lines.some((line) => line.includes('Command: node garda-agent-orchestrator/bin/garda.js gate restore-full-suite-repair-wip')));
        assert.ok(dryRun.output_lines.some((line) => line.includes("--manifest-path 'garda-agent-orchestrator/runtime/wip/")));
        assert.ok(dryRun.output_lines.every((line) => !line.includes('--child-task-id')));
        const restoreCommandLine = dryRun.output_lines.find((line) => line.includes('Command: node garda-agent-orchestrator/bin/garda.js gate restore-full-suite-repair-wip'));
        assert.equal(restoreCommandLine?.includes('--dry-run'), false);
    });

    it('blocks legacy materialized handoff reuse so suspended parent recovery remains reachable', () => {
        const { repoRoot, preflightPath, fullSuitePath } = makeRepo();
        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const value = 2;\n', 'utf8');
        runGit(repoRoot, ['add', 'src/app.ts']);
        const materialized = materializeFullSuiteRepairTask({
            repoRoot,
            taskId: TASK_ID,
            preflightPath,
            fullSuiteArtifactPath: fullSuitePath
        });
        assert.equal(materialized.status, 'MATERIALIZED', materialized.output_lines.join('\n'));
        const manifestPath = materialized.wip_manifest_path || '';
        const manifest = readJson(manifestPath);
        manifest.schema_version = 3;
        delete manifest.child_scopes;
        writeJson(manifestPath, manifest);
        const artifact = readJson(materialized.artifact_path);
        artifact.schema_version = 2;
        delete artifact.child_scopes;
        artifact.wip_manifest_sha256 = fileSha256(manifestPath);
        writeJson(materialized.artifact_path, artifact);

        const retried = materializeFullSuiteRepairTask({
            repoRoot,
            taskId: TASK_ID,
            preflightPath,
            fullSuiteArtifactPath: fullSuitePath
        });

        assert.equal(retried.status, 'BLOCKED', retried.output_lines.join('\n'));
        assert.equal(retried.wip_manifest_path, normalizeForArtifact(manifestPath));
        assert.match(retried.violations.join('\n'), /predates scoped child isolation/);
        assert.match(retried.violations.join('\n'), /do not rematerialize over its capture/);
        assertOperatorNextActionOutput(retried.output_lines, 'FULL_SUITE_REPAIR_TASK_BLOCKED');
    });

    it('single-quotes restore command paths with PowerShell metacharacters', () => {
        const { repoRoot, preflightPath, fullSuitePath } = makeRepo();
        const metacharFullSuitePath = path.join(
            repoRoot,
            'garda-agent-orchestrator',
            'runtime',
            'reviews',
            "pwsh-$(whoami)`x`'tail",
            'full-suite-validation.json'
        );
        fs.mkdirSync(path.dirname(metacharFullSuitePath), { recursive: true });
        fs.copyFileSync(fullSuitePath, metacharFullSuitePath);
        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const value = 2;\n', 'utf8');
        runGit(repoRoot, ['add', 'src/app.ts']);
        const materialized = materializeFullSuiteRepairTask({
            repoRoot,
            taskId: TASK_ID,
            preflightPath,
            fullSuiteArtifactPath: metacharFullSuitePath
        });
        assert.equal(materialized.status, 'MATERIALIZED', materialized.output_lines.join('\n'));

        markRepairChildDone(repoRoot);
        const dryRun = restoreMaterializedWip({
            repoRoot,
            fullSuitePath: metacharFullSuitePath,
            manifestPath: materialized.wip_manifest_path || '',
            dryRun: true
        });

        assert.equal(dryRun.status, 'DRY_RUN_OK', dryRun.output_lines.join('\n'));
        const restoreCommandLine = dryRun.output_lines.find((line) => line.includes('Command: node garda-agent-orchestrator/bin/garda.js gate restore-full-suite-repair-wip')) || '';
        assert.ok(restoreCommandLine.includes("--full-suite-artifact-path 'garda-agent-orchestrator/runtime/reviews/pwsh-$(whoami)`x`''tail/full-suite-validation.json'"));
        assert.ok(restoreCommandLine.includes("--manifest-path 'garda-agent-orchestrator/runtime/wip/"));
        assert.ok(!restoreCommandLine.includes('--child-task-id'));
        assert.equal(restoreCommandLine.includes('--full-suite-artifact-path "'), false);
        assert.equal(restoreCommandLine.includes('--manifest-path "'), false);
    });

    it('does not suspend WIP when durable repair task materialization fails', () => {
        const { repoRoot, preflightPath, fullSuitePath } = makeRepo();
        const appPath = path.join(repoRoot, 'src', 'app.ts');
        fs.writeFileSync(appPath, 'export const value = 2;\n', 'utf8');
        runGit(repoRoot, ['add', 'src/app.ts']);
        fs.rmSync(path.join(repoRoot, 'TASK.md'), { force: true });

        const materialized = materializeFullSuiteRepairTask({
            repoRoot,
            taskId: TASK_ID,
            preflightPath,
            fullSuiteArtifactPath: fullSuitePath
        });

        assert.equal(materialized.status, 'BLOCKED');
        assert.equal(materialized.wip_manifest_path, null);
        assert.ok(materialized.violations.some((violation) => violation.includes(`repair parent ${TASK_ID} is missing from TASK.md`)));
        assert.equal(fs.readFileSync(appPath, 'utf8'), 'export const value = 2;\n');
        assert.match(runGit(repoRoot, ['diff', '--cached', '--', 'src/app.ts']), /\+export const value = 2;/);
        const repairCaptureRoot = path.join(
            repoRoot,
            'garda-agent-orchestrator',
            'runtime',
            'wip',
            TASK_ID,
            'full-suite-repair'
        );
        assert.deepEqual(fs.existsSync(repairCaptureRoot) ? fs.readdirSync(repairCaptureRoot) : [], []);
    });

    it('cleans capture and preserves WIP when queue materialization throws', () => {
        const { repoRoot, preflightPath, fullSuitePath } = makeRepo();
        const taskPath = path.join(repoRoot, 'TASK.md');
        const originalTaskQueue = fs.readFileSync(taskPath, 'utf8');
        const appPath = path.join(repoRoot, 'src', 'app.ts');
        fs.writeFileSync(appPath, 'export const value = 2;\n', 'utf8');
        runGit(repoRoot, ['add', 'src/app.ts']);

        const fsModule = require('node:fs') as typeof import('node:fs');
        const originalReadFileSync = fsModule.readFileSync;
        let taskReadCount = 0;
        fsModule.readFileSync = ((...args: unknown[]) => {
            if (typeof args[0] !== 'number' && path.resolve(String(args[0])) === path.resolve(taskPath)) {
                taskReadCount += 1;
                if (taskReadCount === 2) {
                    throw new Error('injected queue read failure');
                }
            }
            return Reflect.apply(originalReadFileSync, fsModule, args) as unknown;
        }) as typeof fsModule.readFileSync;
        let materialized: ReturnType<typeof materializeFullSuiteRepairTask> | null = null;
        try {
            materialized = materializeFullSuiteRepairTask({
                repoRoot,
                taskId: TASK_ID,
                preflightPath,
                fullSuiteArtifactPath: fullSuitePath
            });
        } finally {
            fsModule.readFileSync = originalReadFileSync;
        }

        assert.equal(materialized?.status, 'BLOCKED');
        assert.ok(materialized?.violations.some((violation) => violation.includes('injected queue read failure')));
        assert.equal(fs.readFileSync(appPath, 'utf8'), 'export const value = 2;\n');
        assert.match(runGit(repoRoot, ['diff', '--cached', '--', 'src/app.ts']), /\+export const value = 2;/);
        assertMaterializationControlPlaneRolledBack(repoRoot, originalTaskQueue);
    });

    it('aborts and rolls back when the repair decomposition changes under the task-queue lock', () => {
        const { repoRoot, preflightPath, fullSuitePath } = makeRepo();
        const taskPath = path.join(repoRoot, 'TASK.md');
        const originalTaskQueue = fs.readFileSync(taskPath, 'utf8');
        const driftedTaskQueue = originalTaskQueue.replace(`, \`${SECOND_CHILD_TASK_ID}\``, '');
        const appPath = path.join(repoRoot, 'src', 'app.ts');
        fs.writeFileSync(appPath, 'export const value = 2;\n', 'utf8');
        runGit(repoRoot, ['add', 'src/app.ts']);

        const fsModule = require('node:fs') as typeof import('node:fs');
        const originalReadFileSync = fsModule.readFileSync;
        let taskReadCount = 0;
        fsModule.readFileSync = ((...args: unknown[]) => {
            if (typeof args[0] !== 'number' && path.resolve(String(args[0])) === path.resolve(taskPath)) {
                taskReadCount += 1;
                if (taskReadCount === 4) {
                    fs.writeFileSync(taskPath, driftedTaskQueue, 'utf8');
                }
            }
            return Reflect.apply(originalReadFileSync, fsModule, args) as unknown;
        }) as typeof fsModule.readFileSync;
        let materialized: ReturnType<typeof materializeFullSuiteRepairTask> | null = null;
        try {
            materialized = materializeFullSuiteRepairTask({
                repoRoot,
                taskId: TASK_ID,
                preflightPath,
                fullSuiteArtifactPath: fullSuitePath
            });
        } finally {
            fsModule.readFileSync = originalReadFileSync;
        }

        assert.equal(materialized?.status, 'BLOCKED');
        assert.ok(
            materialized?.violations.some((violation) => violation.includes('decomposition_changed')),
            materialized?.violations.join('\n')
        );
        assert.equal(fs.readFileSync(appPath, 'utf8'), 'export const value = 2;\n');
        assert.match(runGit(repoRoot, ['diff', '--cached', '--', 'src/app.ts']), /\+export const value = 2;/);
        assertMaterializationControlPlaneRolledBack(repoRoot, originalTaskQueue);
    });

    it('aborts and rolls back when the repair decomposition changes before WIP suspension', () => {
        const { repoRoot, preflightPath, fullSuitePath } = makeRepo();
        const taskPath = path.resolve(repoRoot, 'TASK.md');
        const originalTaskQueue = fs.readFileSync(taskPath, 'utf8');
        const appPath = path.join(repoRoot, 'src', 'app.ts');
        fs.writeFileSync(appPath, 'export const value = 2;\n', 'utf8');
        runGit(repoRoot, ['add', 'src/app.ts']);

        const fsModule = require('node:fs') as typeof import('node:fs');
        const originalRenameSync = fsModule.renameSync;
        let injected = false;
        fsModule.renameSync = ((oldPath: fs.PathLike, newPath: fs.PathLike) => {
            const content = path.resolve(String(newPath)) === taskPath
                ? fs.readFileSync(oldPath, 'utf8')
                : '';
            if (!injected
                && path.resolve(String(newPath)) === taskPath
                && content.includes(`| ${TASK_ID} | 🟫 SPLIT_REQUIRED |`)) {
                injected = true;
                fs.writeFileSync(
                    oldPath,
                    content.replace(`, \`${SECOND_CHILD_TASK_ID}\``, ''),
                    'utf8'
                );
            }
            return originalRenameSync(oldPath, newPath);
        }) as typeof fsModule.renameSync;
        let materialized: ReturnType<typeof materializeFullSuiteRepairTask> | null = null;
        try {
            materialized = materializeFullSuiteRepairTask({
                repoRoot,
                taskId: TASK_ID,
                preflightPath,
                fullSuiteArtifactPath: fullSuitePath
            });
        } finally {
            fsModule.renameSync = originalRenameSync;
        }

        assert.equal(injected, true);
        assert.equal(materialized?.status, 'BLOCKED');
        assert.ok(
            materialized?.violations.some((violation) => violation.includes('decomposition_changed')),
            materialized?.violations.join('\n')
        );
        assert.equal(fs.readFileSync(appPath, 'utf8'), 'export const value = 2;\n');
        assert.match(runGit(repoRoot, ['diff', '--cached', '--', 'src/app.ts']), /\+export const value = 2;/);
        assertMaterializationControlPlaneRolledBack(repoRoot, originalTaskQueue);
    });

    it('rolls back queue changes when initial split-required artifact creation throws', () => {
        const { repoRoot, preflightPath, fullSuitePath } = makeRepo();
        const taskPath = path.join(repoRoot, 'TASK.md');
        const originalTaskQueue = fs.readFileSync(taskPath, 'utf8');
        const appPath = path.join(repoRoot, 'src', 'app.ts');
        fs.writeFileSync(appPath, 'export const value = 2;\n', 'utf8');
        runGit(repoRoot, ['add', 'src/app.ts']);
        const splitArtifactPath = path.resolve(
            repoRoot,
            'garda-agent-orchestrator',
            'runtime',
            'reviews',
            `${TASK_ID}-split-required.json`
        );

        const fsModule = require('node:fs') as typeof import('node:fs');
        const originalRenameSync = fsModule.renameSync;
        let injected = false;
        fsModule.renameSync = ((oldPath: fs.PathLike, newPath: fs.PathLike) => {
            if (!injected
                && path.resolve(String(newPath)) === splitArtifactPath) {
                injected = true;
                throw new Error('injected split artifact creation failure');
            }
            return originalRenameSync(oldPath, newPath);
        }) as typeof fsModule.renameSync;
        let materialized: ReturnType<typeof materializeFullSuiteRepairTask> | null = null;
        try {
            materialized = materializeFullSuiteRepairTask({
                repoRoot,
                taskId: TASK_ID,
                preflightPath,
                fullSuiteArtifactPath: fullSuitePath
            });
        } finally {
            fsModule.renameSync = originalRenameSync;
        }

        assert.equal(injected, true);
        assert.equal(materialized?.status, 'BLOCKED');
        assert.ok(materialized?.violations.some((violation) => violation.includes('split artifact creation failure')));
        assert.equal(fs.readFileSync(appPath, 'utf8'), 'export const value = 2;\n');
        assert.match(runGit(repoRoot, ['diff', '--cached', '--', 'src/app.ts']), /\+export const value = 2;/);
        assertMaterializationControlPlaneRolledBack(repoRoot, originalTaskQueue);
    });

    it('rolls back queue and latch artifacts when latch status synchronization fails', () => {
        const { repoRoot, preflightPath, fullSuitePath } = makeRepo();
        const taskPath = path.resolve(repoRoot, 'TASK.md');
        const originalTaskQueue = fs.readFileSync(taskPath, 'utf8');
        const appPath = path.join(repoRoot, 'src', 'app.ts');
        fs.writeFileSync(appPath, 'export const value = 2;\n', 'utf8');
        runGit(repoRoot, ['add', 'src/app.ts']);

        const fsModule = require('node:fs') as typeof import('node:fs');
        const originalRenameSync = fsModule.renameSync;
        let injected = false;
        fsModule.renameSync = ((oldPath: fs.PathLike, newPath: fs.PathLike) => {
            const content = path.resolve(String(newPath)) === taskPath
                ? fs.readFileSync(oldPath, 'utf8')
                : '';
            if (!injected
                && path.resolve(String(newPath)) === taskPath
                && content.includes('SPLIT_REQUIRED')) {
                injected = true;
                throw new Error('injected latch status write failure');
            }
            return originalRenameSync(oldPath, newPath);
        }) as typeof fsModule.renameSync;
        let materialized: ReturnType<typeof materializeFullSuiteRepairTask> | null = null;
        try {
            materialized = materializeFullSuiteRepairTask({
                repoRoot,
                taskId: TASK_ID,
                preflightPath,
                fullSuiteArtifactPath: fullSuitePath
            });
        } finally {
            fsModule.renameSync = originalRenameSync;
        }

        assert.equal(injected, true);
        assert.equal(materialized?.status, 'BLOCKED');
        assert.ok(materialized?.violations.some((violation) => violation.includes('latch status write failure')));
        assert.equal(fs.readFileSync(appPath, 'utf8'), 'export const value = 2;\n');
        assertMaterializationControlPlaneRolledBack(repoRoot, originalTaskQueue);
    });

    it('restores staged and unstaged WIP when suspension checkout fails after reset', () => {
        const { repoRoot, preflightPath, fullSuitePath } = makeRepo();
        const taskPath = path.join(repoRoot, 'TASK.md');
        const originalTaskQueue = fs.readFileSync(taskPath, 'utf8');
        const appPath = path.join(repoRoot, 'src', 'app.ts');
        fs.writeFileSync(appPath, 'export const value = 2;\n', 'utf8');
        runGit(repoRoot, ['add', 'src/app.ts']);
        fs.writeFileSync(appPath, 'export const value = 3;\n', 'utf8');

        const childProcessModule = require('node:child_process') as typeof import('node:child_process');
        const originalExecFileSync = childProcessModule.execFileSync;
        let injected = false;
        childProcessModule.execFileSync = ((file: string, args?: readonly string[], options?: childProcess.ExecFileSyncOptions) => {
            const commandArgs = Array.isArray(args) ? args.map(String) : [];
            if (!injected
                && file === 'git'
                && commandArgs.includes('checkout')
                && commandArgs.includes('src/app.ts')) {
                injected = true;
                throw new Error('injected suspension checkout failure');
            }
            return Reflect.apply(originalExecFileSync, childProcessModule, [file, args, options]);
        }) as typeof childProcessModule.execFileSync;
        let materialized: ReturnType<typeof materializeFullSuiteRepairTask> | null = null;
        try {
            materialized = materializeFullSuiteRepairTask({
                repoRoot,
                taskId: TASK_ID,
                preflightPath,
                fullSuiteArtifactPath: fullSuitePath
            });
        } finally {
            childProcessModule.execFileSync = originalExecFileSync;
        }

        assert.equal(injected, true);
        assert.equal(materialized?.status, 'BLOCKED');
        assert.ok(materialized?.violations.some((violation) => violation.includes('suspension checkout failure')));
        assert.equal(fs.readFileSync(appPath, 'utf8'), 'export const value = 3;\n');
        assert.match(runGit(repoRoot, ['diff', '--cached', '--', 'src/app.ts']), /\+export const value = 2;/);
        assert.match(
            runGit(repoRoot, ['diff', '--', 'src/app.ts']),
            /[-]export const value = 2;[\s\S]*[+]export const value = 3;/
        );
        assertMaterializationControlPlaneRolledBack(repoRoot, originalTaskQueue);
    });

    it('restores already removed untracked WIP when a later suspension removal fails', () => {
        const { repoRoot, preflightPath, fullSuitePath } = makeRepo();
        const taskPath = path.join(repoRoot, 'TASK.md');
        const originalTaskQueue = fs.readFileSync(taskPath, 'utf8');
        const firstPath = path.join(repoRoot, 'src', 'a-helper.ts');
        const secondPath = path.join(repoRoot, 'src', 'b-helper.ts');
        fs.writeFileSync(firstPath, 'export const first = true;\n', 'utf8');
        fs.writeFileSync(secondPath, 'export const second = true;\n', 'utf8');
        const preflight = readJson(preflightPath);
        preflight.changed_files = ['src/app.ts', 'src/a-helper.ts', 'src/b-helper.ts'];
        writeJson(preflightPath, preflight);

        const fsModule = require('node:fs') as typeof import('node:fs');
        const originalUnlinkSync = fsModule.unlinkSync;
        let injected = false;
        fsModule.unlinkSync = ((filePath: fs.PathLike) => {
            if (!injected && path.resolve(String(filePath)) === path.resolve(secondPath)) {
                injected = true;
                throw new Error('injected second untracked removal failure');
            }
            return originalUnlinkSync(filePath);
        }) as typeof fsModule.unlinkSync;
        let materialized: ReturnType<typeof materializeFullSuiteRepairTask> | null = null;
        try {
            materialized = materializeFullSuiteRepairTask({
                repoRoot,
                taskId: TASK_ID,
                preflightPath,
                fullSuiteArtifactPath: fullSuitePath
            });
        } finally {
            fsModule.unlinkSync = originalUnlinkSync;
        }

        assert.equal(injected, true);
        assert.equal(materialized?.status, 'BLOCKED');
        assert.ok(materialized?.violations.some((violation) => violation.includes('second untracked removal failure')));
        assert.equal(fs.readFileSync(firstPath, 'utf8'), 'export const first = true;\n');
        assert.equal(fs.readFileSync(secondPath, 'utf8'), 'export const second = true;\n');
        assertMaterializationControlPlaneRolledBack(repoRoot, originalTaskQueue);
    });

    it('restores WIP and control plane when the materialization artifact write fails', () => {
        const { repoRoot, preflightPath, fullSuitePath } = makeRepo();
        const taskPath = path.join(repoRoot, 'TASK.md');
        const originalTaskQueue = fs.readFileSync(taskPath, 'utf8');
        const appPath = path.join(repoRoot, 'src', 'app.ts');
        fs.writeFileSync(appPath, 'export const value = 2;\n', 'utf8');
        runGit(repoRoot, ['add', 'src/app.ts']);
        const repairArtifactPath = path.resolve(
            repoRoot,
            'garda-agent-orchestrator',
            'runtime',
            'reviews',
            `${TASK_ID}-full-suite-repair-task.json`
        );

        const fsModule = require('node:fs') as typeof import('node:fs');
        const originalWriteFileSync = fsModule.writeFileSync;
        let injected = false;
        fsModule.writeFileSync = ((filePath: fs.PathOrFileDescriptor, data: string | NodeJS.ArrayBufferView, options?: fs.WriteFileOptions) => {
            if (!injected
                && typeof filePath !== 'number'
                && path.resolve(String(filePath)) === repairArtifactPath) {
                injected = true;
                throw new Error('injected materialization artifact write failure');
            }
            return originalWriteFileSync(filePath, data, options);
        }) as typeof fsModule.writeFileSync;
        let materialized: ReturnType<typeof materializeFullSuiteRepairTask> | null = null;
        try {
            materialized = materializeFullSuiteRepairTask({
                repoRoot,
                taskId: TASK_ID,
                preflightPath,
                fullSuiteArtifactPath: fullSuitePath
            });
        } finally {
            fsModule.writeFileSync = originalWriteFileSync;
        }

        assert.equal(injected, true);
        assert.equal(materialized?.status, 'BLOCKED');
        assert.ok(materialized?.violations.some((violation) => violation.includes('materialization artifact write failure')));
        assert.equal(fs.readFileSync(appPath, 'utf8'), 'export const value = 2;\n');
        assert.match(runGit(repoRoot, ['diff', '--cached', '--', 'src/app.ts']), /\+export const value = 2;/);
        assert.equal(readJson(repairArtifactPath).status, 'BLOCKED');
        assertMaterializationControlPlaneRolledBack(repoRoot, originalTaskQueue);
        const taskEventsPath = path.join(
            repoRoot,
            'garda-agent-orchestrator',
            'runtime',
            'task-events',
            `${TASK_ID}.jsonl`
        );
        const statusEvents = fs.readFileSync(taskEventsPath, 'utf8')
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line) as { event_type: string; details?: Record<string, unknown> })
            .filter((event) => event.event_type === 'STATUS_CHANGED');
        assert.deepEqual(
            statusEvents.map((event) => event.details?.new_status),
            ['SPLIT_REQUIRED', 'IN_PROGRESS']
        );
    });

    it('preserves a pre-existing repair artifact and writes rollback failure evidence to a sidecar', () => {
        const { repoRoot, preflightPath, fullSuitePath } = makeRepo();
        const taskPath = path.join(repoRoot, 'TASK.md');
        const originalTaskQueue = fs.readFileSync(taskPath, 'utf8');
        const appPath = path.join(repoRoot, 'src', 'app.ts');
        fs.writeFileSync(appPath, 'export const value = 2;\n', 'utf8');
        runGit(repoRoot, ['add', 'src/app.ts']);
        const repairArtifactPath = path.resolve(
            repoRoot,
            'garda-agent-orchestrator',
            'runtime',
            'reviews',
            `${TASK_ID}-full-suite-repair-task.json`
        );
        const splitArtifactPath = path.resolve(
            repoRoot,
            'garda-agent-orchestrator',
            'runtime',
            'reviews',
            `${TASK_ID}-split-required.json`
        );
        const previousArtifactBytes = Buffer.from('pre-existing repair evidence\n', 'utf8');
        fs.writeFileSync(repairArtifactPath, previousArtifactBytes);

        const fsModule = require('node:fs') as typeof import('node:fs');
        const originalRenameSync = fsModule.renameSync;
        let injected = false;
        fsModule.renameSync = ((oldPath: fs.PathLike, newPath: fs.PathLike) => {
            if (!injected
                && path.resolve(String(newPath)) === splitArtifactPath) {
                injected = true;
                throw new Error('injected split artifact failure with prior evidence');
            }
            return originalRenameSync(oldPath, newPath);
        }) as typeof fsModule.renameSync;
        let materialized: ReturnType<typeof materializeFullSuiteRepairTask> | null = null;
        try {
            materialized = materializeFullSuiteRepairTask({
                repoRoot,
                taskId: TASK_ID,
                preflightPath,
                fullSuiteArtifactPath: fullSuitePath
            });
        } finally {
            fsModule.renameSync = originalRenameSync;
        }

        assert.equal(injected, true);
        assert.equal(materialized?.status, 'BLOCKED');
        assert.ok(materialized?.violations.some((violation) => violation.includes('prior evidence')));
        assert.deepEqual(fs.readFileSync(repairArtifactPath), previousArtifactBytes);
        assert.notEqual(path.resolve(materialized?.artifact_path || ''), repairArtifactPath);
        assert.equal(readJson(materialized?.artifact_path || '').status, 'BLOCKED');
        assert.equal(fs.readFileSync(taskPath, 'utf8'), originalTaskQueue);
        assert.equal(fs.readFileSync(appPath, 'utf8'), 'export const value = 2;\n');
        assertMaterializationControlPlaneRolledBack(repoRoot, originalTaskQueue);
    });

    it('restores WIP and control plane when the mandatory materialized event cannot commit', () => {
        const { repoRoot, preflightPath, fullSuitePath } = makeRepo();
        const taskPath = path.join(repoRoot, 'TASK.md');
        const originalTaskQueue = fs.readFileSync(taskPath, 'utf8');
        const appPath = path.join(repoRoot, 'src', 'app.ts');
        fs.writeFileSync(appPath, 'export const value = 2;\n', 'utf8');
        runGit(repoRoot, ['add', 'src/app.ts']);

        const taskEventsIo = require('../../../../src/gate-runtime/timeline/task-events-io') as typeof import('../../../../src/gate-runtime/timeline/task-events-io');
        const originalAppendMandatoryTaskEvent = taskEventsIo.appendMandatoryTaskEvent;
        let injected = false;
        const appendMock = mock.method(
            taskEventsIo,
            'appendMandatoryTaskEvent',
            ((...args: Parameters<typeof originalAppendMandatoryTaskEvent>) => {
                if (!injected && args[2] === 'FULL_SUITE_REPAIR_TASK_MATERIALIZED') {
                    injected = true;
                    throw new Error('injected mandatory materialized-event failure');
                }
                return originalAppendMandatoryTaskEvent(...args);
            }) as typeof originalAppendMandatoryTaskEvent
        );
        let materialized: ReturnType<typeof materializeFullSuiteRepairTask> | null = null;
        try {
            materialized = materializeFullSuiteRepairTask({
                repoRoot,
                taskId: TASK_ID,
                preflightPath,
                fullSuiteArtifactPath: fullSuitePath
            });
        } finally {
            appendMock.mock.restore();
        }

        assert.equal(injected, true);
        assert.equal(materialized?.status, 'BLOCKED');
        assert.ok(materialized?.violations.some((violation) => violation.includes('materialized-event failure')));
        assert.equal(fs.readFileSync(appPath, 'utf8'), 'export const value = 2;\n');
        assert.match(runGit(repoRoot, ['diff', '--cached', '--', 'src/app.ts']), /\+export const value = 2;/);
        assertMaterializationControlPlaneRolledBack(repoRoot, originalTaskQueue);
    });

    it('suspends and restores visible untracked files inside the preflight scope', () => {
        const { repoRoot, preflightPath, fullSuitePath } = makeRepo();
        const preflight = readJson(preflightPath);
        preflight.changed_files = ['src/app.ts', 'src/new-helper.ts'];
        writeJson(preflightPath, preflight);
        const newHelperPath = path.join(repoRoot, 'src', 'new-helper.ts');
        fs.writeFileSync(newHelperPath, 'export const helper = true;\n', 'utf8');

        const materialized = materializeFullSuiteRepairTask({
            repoRoot,
            taskId: TASK_ID,
            preflightPath,
            fullSuiteArtifactPath: fullSuitePath
        });

        assert.equal(materialized.status, 'MATERIALIZED', materialized.output_lines.join('\n'));
        assert.equal(fs.existsSync(newHelperPath), false);
        const manifest = readJson(materialized.wip_manifest_path || '');
        const untrackedPaths = (manifest.untracked_files as Array<Record<string, unknown>>).map((entry) => entry.path);
        assert.ok(untrackedPaths.includes('src/new-helper.ts'));
        markRepairChildDone(repoRoot);

        const restored = restoreMaterializedWip({
            repoRoot,
            fullSuitePath,
            manifestPath: materialized.wip_manifest_path || ''
        });

        assert.equal(restored.status, 'RESTORED', restored.output_lines.join('\n'));
        assert.equal(fs.readFileSync(newHelperPath, 'utf8'), 'export const helper = true;\n');
    });

    it('preserves authenticated untracked mode and blocks artifact mode tampering', (t) => {
        const { repoRoot, preflightPath, fullSuitePath } = makeRepo();
        const relativePath = 'src/mode-helper.sh';
        const helperPath = path.join(repoRoot, relativePath);
        const preflight = readJson(preflightPath);
        preflight.changed_files = ['src/app.ts', relativePath];
        writeJson(preflightPath, preflight);
        fs.writeFileSync(helperPath, '#!/usr/bin/env node\n', 'utf8');
        fs.chmodSync(helperPath, process.platform === 'win32' ? 0o444 : 0o751);
        const capturedMode = fs.statSync(helperPath).mode & 0o777;
        const materialized = materializeFullSuiteRepairTask({
            repoRoot,
            taskId: TASK_ID,
            preflightPath,
            fullSuiteArtifactPath: fullSuitePath
        });
        assert.equal(materialized.status, 'MATERIALIZED', materialized.output_lines.join('\n'));
        const manifestPath = materialized.wip_manifest_path || '';
        const manifest = readJson(manifestPath);
        const untrackedEntry = (manifest.untracked_files as Array<Record<string, unknown>>)
            .find((entry) => entry.path === relativePath);
        assert.ok(untrackedEntry);
        assert.equal(untrackedEntry.mode, capturedMode);
        const artifactPath = String(untrackedEntry.artifact_path);
        const tamperedMode = (capturedMode & 0o222) === 0 ? capturedMode | 0o200 : capturedMode & ~0o222;
        fs.chmodSync(artifactPath, tamperedMode);
        const effectiveTamperedMode = fs.statSync(artifactPath).mode & 0o777;
        if (effectiveTamperedMode === capturedMode) {
            t.skip('filesystem does not expose a mutable permission mode');
            return;
        }
        markRepairChildDone(repoRoot);

        const tamperedRestore = restoreMaterializedWip({
            repoRoot,
            fullSuitePath,
            manifestPath
        });
        assert.equal(tamperedRestore.status, 'BLOCKED');
        assert.ok(tamperedRestore.violations.some((violation) => violation.includes('mode mismatch')));
        assert.equal(fs.existsSync(helperPath), false);

        fs.chmodSync(artifactPath, capturedMode);
        const restored = restoreMaterializedWip({
            repoRoot,
            fullSuitePath,
            manifestPath
        });
        assert.equal(restored.status, 'RESTORED', restored.output_lines.join('\n'));
        assert.equal(fs.statSync(helperPath).mode & 0o777, capturedMode);
        fs.chmodSync(helperPath, 0o666);
    });

    it('blocks untracked restore through a symbolic-link or junction ancestor', () => {
        const { repoRoot, preflightPath, fullSuitePath } = makeRepo();
        const preflight = readJson(preflightPath);
        preflight.changed_files = ['src/app.ts', 'src/new-helper.ts'];
        writeJson(preflightPath, preflight);
        const newHelperPath = path.join(repoRoot, 'src', 'new-helper.ts');
        fs.writeFileSync(newHelperPath, 'export const helper = true;\n', 'utf8');
        const materialized = materializeFullSuiteRepairTask({
            repoRoot,
            taskId: TASK_ID,
            preflightPath,
            fullSuiteArtifactPath: fullSuitePath
        });
        assert.equal(materialized.status, 'MATERIALIZED', materialized.output_lines.join('\n'));

        const externalRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-full-suite-repair-external-'));
        tempRoots.push(externalRoot);
        const linkPath = path.join(repoRoot, 'restore-link');
        fs.symlinkSync(externalRoot, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
        const manifestPath = materialized.wip_manifest_path || '';
        const manifest = readJson(manifestPath);
        const untrackedFiles = manifest.untracked_files as Array<Record<string, unknown>>;
        assert.equal(untrackedFiles.length, 1);
        const reboundArtifactPath = path.join(
            path.dirname(manifestPath),
            'untracked',
            'restore-link',
            'escaped.ts'
        );
        fs.mkdirSync(path.dirname(reboundArtifactPath), { recursive: true });
        fs.copyFileSync(String(untrackedFiles[0].artifact_path), reboundArtifactPath);
        fs.chmodSync(reboundArtifactPath, Number(untrackedFiles[0].mode));
        untrackedFiles[0].path = 'restore-link/escaped.ts';
        untrackedFiles[0].artifact_path = normalizeForArtifact(reboundArtifactPath);
        untrackedFiles[0].sha256 = fileSha256(reboundArtifactPath);
        untrackedFiles[0].bytes = fs.statSync(reboundArtifactPath).size;
        writeJson(manifestPath, manifest);
        refreshMaterializationManifestSha(repoRoot, manifestPath);
        markRepairChildDone(repoRoot);

        const restored = restoreMaterializedWip({
            repoRoot,
            fullSuitePath,
            manifestPath
        });

        assert.equal(restored.status, 'BLOCKED');
        assert.ok(restored.violations.some((violation) => violation.includes('symbolic-link or junction')));
        assert.equal(fs.existsSync(path.join(externalRoot, 'escaped.ts')), false);
    });

    it('blocks restore when a nested untracked parent directory is missing', () => {
        const { repoRoot, preflightPath, fullSuitePath } = makeRepo();
        const preflight = readJson(preflightPath);
        preflight.changed_files = ['src/app.ts', 'src/restore-target/nested/helper.ts'];
        writeJson(preflightPath, preflight);
        const appPath = path.join(repoRoot, 'src', 'app.ts');
        const restoreParentPath = path.join(repoRoot, 'src', 'restore-target');
        const helperPath = path.join(restoreParentPath, 'nested', 'helper.ts');
        fs.mkdirSync(path.dirname(helperPath), { recursive: true });
        fs.writeFileSync(appPath, 'export const value = 2;\n', 'utf8');
        fs.writeFileSync(helperPath, 'export const helper = true;\n', 'utf8');
        runGit(repoRoot, ['add', 'src/app.ts']);
        const materialized = materializeFullSuiteRepairTask({
            repoRoot,
            taskId: TASK_ID,
            preflightPath,
            fullSuiteArtifactPath: fullSuitePath
        });
        assert.equal(materialized.status, 'MATERIALIZED', materialized.output_lines.join('\n'));
        markRepairChildDone(repoRoot);
        fs.rmSync(restoreParentPath, { recursive: true, force: true });

        const restored = restoreMaterializedWip({
            repoRoot,
            fullSuitePath,
            manifestPath: materialized.wip_manifest_path || ''
        });

        assert.equal(restored.status, 'BLOCKED');
        assert.ok(restored.violations.some((violation) => violation.includes(
            'parent directory must already exist'
        )));
        assert.equal(fs.existsSync(helperPath), false);
        assert.equal(fs.readFileSync(appPath, 'utf8'), 'export const value = 1;\n');
        assert.equal(runGit(repoRoot, ['diff', '--name-only', '--cached']).trim(), '');
    });

    it('rolls back when an untracked target ancestor is swapped to a junction during exclusive creation', () => {
        const { repoRoot, preflightPath, fullSuitePath } = makeRepo();
        const preflight = readJson(preflightPath);
        preflight.changed_files = ['src/app.ts', 'src/restore-target/helper.ts'];
        writeJson(preflightPath, preflight);
        const appPath = path.join(repoRoot, 'src', 'app.ts');
        const helperPath = path.join(repoRoot, 'src', 'restore-target', 'helper.ts');
        fs.mkdirSync(path.dirname(helperPath), { recursive: true });
        fs.writeFileSync(appPath, 'export const value = 2;\n', 'utf8');
        fs.writeFileSync(helperPath, 'export const helper = true;\n', 'utf8');
        runGit(repoRoot, ['add', 'src/app.ts']);
        const materialized = materializeFullSuiteRepairTask({
            repoRoot,
            taskId: TASK_ID,
            preflightPath,
            fullSuiteArtifactPath: fullSuitePath
        });
        assert.equal(materialized.status, 'MATERIALIZED', materialized.output_lines.join('\n'));
        markRepairChildDone(repoRoot);

        const externalRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-full-suite-swap-external-'));
        tempRoots.push(externalRoot);
        const fsModule = require('node:fs') as typeof import('node:fs');
        const originalOpenSync = fsModule.openSync;
        let injectedSwap = false;
        fsModule.openSync = ((filePath: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
            if (!injectedSwap && path.resolve(String(filePath)) === path.resolve(helperPath)) {
                injectedSwap = true;
                fs.rmSync(path.dirname(helperPath), { recursive: true, force: true });
                fs.symlinkSync(externalRoot, path.dirname(helperPath), process.platform === 'win32' ? 'junction' : 'dir');
            }
            return originalOpenSync(filePath, flags, mode);
        }) as typeof fsModule.openSync;
        let restored: ReturnType<typeof restoreMaterializedWip> | null = null;
        try {
            restored = restoreMaterializedWip({
                repoRoot,
                fullSuitePath,
                manifestPath: materialized.wip_manifest_path || ''
            });
        } finally {
            fsModule.openSync = originalOpenSync;
        }

        assert.equal(injectedSwap, true);
        assert.equal(restored?.status, 'BLOCKED');
        assert.ok(restored?.violations.some((violation) => violation.includes('symbolic-link or junction')));
        assert.equal(fs.existsSync(path.join(externalRoot, 'helper.ts')), false);
        assert.equal(fs.readFileSync(appPath, 'utf8'), 'export const value = 1;\n');
        assert.equal(runGit(repoRoot, ['diff', '--name-only', '--cached']).trim(), '');
    });

    it('rejects an exclusively created untracked target that gains an additional hard link before write', () => {
        const { repoRoot, preflightPath, fullSuitePath } = makeRepo();
        const preflight = readJson(preflightPath);
        preflight.changed_files = ['src/app.ts', 'src/restore-target/helper.ts'];
        writeJson(preflightPath, preflight);
        const appPath = path.join(repoRoot, 'src', 'app.ts');
        const helperPath = path.join(repoRoot, 'src', 'restore-target', 'helper.ts');
        const helperParent = path.dirname(helperPath);
        fs.mkdirSync(helperParent, { recursive: true });
        fs.writeFileSync(appPath, 'export const value = 2;\n', 'utf8');
        fs.writeFileSync(helperPath, 'export const helper = true;\n', 'utf8');
        runGit(repoRoot, ['add', 'src/app.ts']);
        const materialized = materializeFullSuiteRepairTask({
            repoRoot,
            taskId: TASK_ID,
            preflightPath,
            fullSuiteArtifactPath: fullSuitePath
        });
        assert.equal(materialized.status, 'MATERIALIZED', materialized.output_lines.join('\n'));
        markRepairChildDone(repoRoot);

        const externalRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-full-suite-hardlink-external-'));
        tempRoots.push(externalRoot);
        const externalHelperPath = path.join(externalRoot, 'helper.ts');
        const parkedParent = `${helperParent}.parked`;
        const fsModule = require('node:fs') as typeof import('node:fs');
        const originalOpenSync = fsModule.openSync;
        let injectedHardLink = false;
        fsModule.openSync = ((filePath: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
            if (injectedHardLink || path.resolve(String(filePath)) !== path.resolve(helperPath)) {
                return originalOpenSync(filePath, flags, mode);
            }
            injectedHardLink = true;
            fs.renameSync(helperParent, parkedParent);
            fs.symlinkSync(externalRoot, helperParent, process.platform === 'win32' ? 'junction' : 'dir');
            const targetFd = originalOpenSync(filePath, flags, mode);
            try {
                fs.unlinkSync(helperParent);
                fs.renameSync(parkedParent, helperParent);
                fs.linkSync(externalHelperPath, helperPath);
                return targetFd;
            } catch (error: unknown) {
                fs.closeSync(targetFd);
                throw error;
            }
        }) as typeof fsModule.openSync;
        let restored: ReturnType<typeof restoreMaterializedWip> | null = null;
        try {
            restored = restoreMaterializedWip({
                repoRoot,
                fullSuitePath,
                manifestPath: materialized.wip_manifest_path || ''
            });
        } finally {
            fsModule.openSync = originalOpenSync;
        }

        assert.equal(injectedHardLink, true);
        assert.equal(restored?.status, 'BLOCKED');
        assert.ok(restored?.violations.some((violation) => violation.includes('additional hard links')));
        assert.equal(fs.existsSync(helperPath), false);
        assert.equal(fs.readFileSync(externalHelperPath).byteLength, 0);
        assert.equal(fs.readFileSync(appPath, 'utf8'), 'export const value = 1;\n');
        assert.equal(runGit(repoRoot, ['diff', '--name-only', '--cached']).trim(), '');
    });

    it('rolls back tracked patches when an exclusive untracked restore cannot be created', () => {
        const { repoRoot, preflightPath, fullSuitePath } = makeRepo();
        const preflight = readJson(preflightPath);
        preflight.changed_files = ['src/app.ts', 'src/restore-target/helper.ts'];
        writeJson(preflightPath, preflight);
        const appPath = path.join(repoRoot, 'src', 'app.ts');
        const helperPath = path.join(repoRoot, 'src', 'restore-target', 'helper.ts');
        fs.mkdirSync(path.dirname(helperPath), { recursive: true });
        fs.writeFileSync(appPath, 'export const value = 2;\n', 'utf8');
        fs.writeFileSync(helperPath, 'export const helper = true;\n', 'utf8');
        runGit(repoRoot, ['add', 'src/app.ts']);

        const materialized = materializeFullSuiteRepairTask({
            repoRoot,
            taskId: TASK_ID,
            preflightPath,
            fullSuiteArtifactPath: fullSuitePath
        });
        assert.equal(materialized.status, 'MATERIALIZED', materialized.output_lines.join('\n'));
        markRepairChildDone(repoRoot);

        const fsModule = require('node:fs') as typeof import('node:fs');
        const originalOpenSync = fsModule.openSync;
        let injectedFailure = false;
        fsModule.openSync = ((filePath: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
            if (!injectedFailure && path.resolve(String(filePath)) === path.resolve(helperPath)) {
                injectedFailure = true;
                throw Object.assign(new Error('exclusive restore obstruction'), { code: 'EEXIST' });
            }
            return originalOpenSync(filePath, flags, mode);
        }) as typeof fsModule.openSync;
        let restored: ReturnType<typeof restoreMaterializedWip> | null = null;
        try {
            restored = restoreMaterializedWip({
                repoRoot,
                fullSuitePath,
                manifestPath: materialized.wip_manifest_path || ''
            });
        } finally {
            fsModule.openSync = originalOpenSync;
        }

        assert.equal(injectedFailure, true);
        assert.equal(restored?.status, 'BLOCKED');
        assert.ok(restored?.violations.some((violation) => violation.includes('restore transaction failed')));
        assert.equal(fs.readFileSync(appPath, 'utf8'), 'export const value = 1;\n');
        assert.equal(runGit(repoRoot, ['diff', '--cached', '--name-only']).trim(), '');
        assert.equal(fs.existsSync(helperPath), false);
    });

    it('rolls back applied WIP when parent status synchronization fails after mutation', () => {
        const { repoRoot, preflightPath, fullSuitePath } = makeRepo();
        const preflight = readJson(preflightPath);
        preflight.changed_files = ['src/app.ts', 'src/new-helper.ts'];
        writeJson(preflightPath, preflight);
        const appPath = path.join(repoRoot, 'src', 'app.ts');
        const helperPath = path.join(repoRoot, 'src', 'new-helper.ts');
        fs.writeFileSync(appPath, 'export const value = 2;\n', 'utf8');
        fs.writeFileSync(helperPath, 'export const helper = true;\n', 'utf8');
        runGit(repoRoot, ['add', 'src/app.ts']);
        const materialized = materializeFullSuiteRepairTask({
            repoRoot,
            taskId: TASK_ID,
            preflightPath,
            fullSuiteArtifactPath: fullSuitePath
        });
        assert.equal(materialized.status, 'MATERIALIZED', materialized.output_lines.join('\n'));
        markRepairChildDone(repoRoot);

        const fsModule = require('node:fs') as typeof import('node:fs');
        const originalRenameSync = fsModule.renameSync;
        const taskPath = path.resolve(repoRoot, 'TASK.md');
        fsModule.renameSync = ((oldPath: fs.PathLike, newPath: fs.PathLike) => {
            if (path.resolve(String(newPath)) === taskPath) {
                throw new Error('injected parent status write failure');
            }
            return originalRenameSync(oldPath, newPath);
        }) as typeof fsModule.renameSync;
        let restored: ReturnType<typeof restoreMaterializedWip> | null = null;
        try {
            restored = restoreMaterializedWip({
                repoRoot,
                fullSuitePath,
                manifestPath: materialized.wip_manifest_path || ''
            });
        } finally {
            fsModule.renameSync = originalRenameSync;
        }

        assert.equal(restored?.status, 'BLOCKED');
        assert.ok(restored?.violations.some((violation) => violation.includes('parent status sync failed:')));
        assert.equal(fs.readFileSync(appPath, 'utf8'), 'export const value = 1;\n');
        assert.equal(fs.existsSync(helperPath), false);
        assert.equal(runGit(repoRoot, ['diff', '--name-only', '--cached']).trim(), '');
        assert.match(fs.readFileSync(taskPath, 'utf8'), new RegExp(`\\| ${TASK_ID} \\| .*SPLIT_REQUIRED .*\\|`));
    });

    it('scrubs hard-linked untracked WIP during rollback after a later failure', () => {
        const { repoRoot, preflightPath, fullSuitePath } = makeRepo();
        const preflight = readJson(preflightPath);
        preflight.changed_files = ['src/app.ts', 'src/new-helper.ts'];
        writeJson(preflightPath, preflight);
        const appPath = path.join(repoRoot, 'src', 'app.ts');
        const helperPath = path.join(repoRoot, 'src', 'new-helper.ts');
        fs.writeFileSync(appPath, 'export const value = 2;\n', 'utf8');
        fs.writeFileSync(helperPath, 'export const helper = true;\n', 'utf8');
        runGit(repoRoot, ['add', 'src/app.ts']);
        const materialized = materializeFullSuiteRepairTask({
            repoRoot,
            taskId: TASK_ID,
            preflightPath,
            fullSuiteArtifactPath: fullSuitePath
        });
        assert.equal(materialized.status, 'MATERIALIZED', materialized.output_lines.join('\n'));
        markRepairChildDone(repoRoot);

        const externalRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-full-suite-rollback-link-'));
        tempRoots.push(externalRoot);
        const externalHelperPath = path.join(externalRoot, 'helper.ts');
        const fsModule = require('node:fs') as typeof import('node:fs');
        const originalRenameSync = fsModule.renameSync;
        const taskPath = path.resolve(repoRoot, 'TASK.md');
        let hardLinkInjected = false;
        fsModule.renameSync = ((oldPath: fs.PathLike, newPath: fs.PathLike) => {
            if (path.resolve(String(newPath)) === taskPath) {
                if (!hardLinkInjected) {
                    fs.linkSync(helperPath, externalHelperPath);
                    hardLinkInjected = true;
                }
                throw new Error('injected parent status write failure after hard link');
            }
            return originalRenameSync(oldPath, newPath);
        }) as typeof fsModule.renameSync;
        let restored: ReturnType<typeof restoreMaterializedWip> | null = null;
        try {
            restored = restoreMaterializedWip({
                repoRoot,
                fullSuitePath,
                manifestPath: materialized.wip_manifest_path || ''
            });
        } finally {
            fsModule.renameSync = originalRenameSync;
        }

        assert.equal(hardLinkInjected, true);
        assert.equal(restored?.status, 'BLOCKED');
        assert.ok(restored?.violations.some((violation) => violation.includes('parent status sync failed:')));
        assert.equal(fs.existsSync(helperPath), false);
        assert.equal(fs.readFileSync(externalHelperPath).byteLength, 0);
        assert.equal(fs.readFileSync(appPath, 'utf8'), 'export const value = 1;\n');
        assert.equal(runGit(repoRoot, ['diff', '--name-only', '--cached']).trim(), '');
    });

    it('rolls back WIP and parent status when the mandatory restored event cannot commit', () => {
        const { repoRoot, preflightPath, fullSuitePath } = makeRepo();
        const preflight = readJson(preflightPath);
        preflight.changed_files = ['src/app.ts', 'src/new-helper.ts'];
        writeJson(preflightPath, preflight);
        const appPath = path.join(repoRoot, 'src', 'app.ts');
        const helperPath = path.join(repoRoot, 'src', 'new-helper.ts');
        fs.writeFileSync(appPath, 'export const value = 2;\n', 'utf8');
        fs.writeFileSync(helperPath, 'export const helper = true;\n', 'utf8');
        runGit(repoRoot, ['add', 'src/app.ts']);
        const materialized = materializeFullSuiteRepairTask({
            repoRoot,
            taskId: TASK_ID,
            preflightPath,
            fullSuiteArtifactPath: fullSuitePath
        });
        assert.equal(materialized.status, 'MATERIALIZED', materialized.output_lines.join('\n'));
        markRepairChildDone(repoRoot);

        const taskEventsIo = require('../../../../src/gate-runtime/timeline/task-events-io') as typeof import('../../../../src/gate-runtime/timeline/task-events-io');
        const originalAppendMandatoryTaskEvent = taskEventsIo.appendMandatoryTaskEvent;
        const appendMock = mock.method(
            taskEventsIo,
            'appendMandatoryTaskEvent',
            ((...args: Parameters<typeof originalAppendMandatoryTaskEvent>) => {
                if (args[2] === 'FULL_SUITE_REPAIR_WIP_RESTORED') {
                    throw new Error('injected mandatory restored-event failure');
                }
                return originalAppendMandatoryTaskEvent(...args);
            }) as typeof originalAppendMandatoryTaskEvent
        );
        let restored: ReturnType<typeof restoreMaterializedWip> | null = null;
        try {
            restored = restoreMaterializedWip({
                repoRoot,
                fullSuitePath,
                manifestPath: materialized.wip_manifest_path || ''
            });
        } finally {
            appendMock.mock.restore();
        }

        assert.equal(restored?.status, 'BLOCKED');
        assert.ok(restored?.violations.some((violation) => violation.includes('mandatory restored-event append failed')));
        assert.equal(fs.readFileSync(appPath, 'utf8'), 'export const value = 1;\n');
        assert.equal(fs.existsSync(helperPath), false);
        assert.equal(runGit(repoRoot, ['diff', '--name-only', '--cached']).trim(), '');
        assert.match(fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8'), new RegExp(`\\| ${TASK_ID} \\| .*SPLIT_REQUIRED .*\\|`));
    });

    it('does not capture unrelated ignored runtime trees while suspending scoped WIP', () => {
        const { repoRoot, preflightPath, fullSuitePath } = makeRepo();
        const ignoredCacheRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'cache', 'bulk');
        fs.mkdirSync(ignoredCacheRoot, { recursive: true });
        for (let index = 0; index < 300; index += 1) {
            fs.writeFileSync(path.join(ignoredCacheRoot, `cache-${index}.log`), `cache ${index}\n`, 'utf8');
        }

        const materialized = materializeFullSuiteRepairTask({
            repoRoot,
            taskId: TASK_ID,
            preflightPath,
            fullSuiteArtifactPath: fullSuitePath
        });

        assert.equal(materialized.status, 'MATERIALIZED', materialized.output_lines.join('\n'));
        const manifest = readJson(materialized.wip_manifest_path || '');
        assert.deepEqual(manifest.untracked_files, []);
        assert.deepEqual(manifest.unrelated_untracked_files, []);
        assert.equal(fs.existsSync(path.join(ignoredCacheRoot, 'cache-299.log')), true);
    });

    it('blocks repair proposals that would inject Markdown table rows', () => {
        const { repoRoot, preflightPath, fullSuitePath } = makeRepo();
        const taskPath = path.join(repoRoot, 'TASK.md');
        const originalTaskQueue = fs.readFileSync(taskPath, 'utf8');
        const fullSuiteArtifact = readJson(fullSuitePath);
        const timeoutPolicy = fullSuiteArtifact.timeout_policy as Record<string, unknown>;
        const proposal = timeoutPolicy.repair_task_proposal as Record<string, unknown>;
        proposal.suggested_task_id = `${TASK_ID}-F1 | DONE`;
        proposal.title = 'Injected\nrow';
        proposal.area = 'workflow/full-suite-timeout | injected';
        writeJson(fullSuitePath, fullSuiteArtifact);

        const materialized = materializeFullSuiteRepairTask({
            repoRoot,
            taskId: TASK_ID,
            preflightPath,
            fullSuiteArtifactPath: fullSuitePath
        });

        assert.equal(materialized.status, 'BLOCKED');
        assert.equal(materialized.wip_manifest_path, null);
        assert.ok(materialized.violations.some((violation) => violation.includes('suggested_task_id must match')));
        assert.ok(materialized.violations.some((violation) => violation.includes('title must not contain')));
        assert.ok(materialized.violations.some((violation) => violation.includes('area must not contain')));
        assert.equal(fs.readFileSync(taskPath, 'utf8'), originalTaskQueue);
    });

    it('restores parent WIP after the repair child advances an unrelated path', () => {
        const { repoRoot, preflightPath, fullSuitePath } = makeRepo();
        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const value = 2;\n', 'utf8');
        runGit(repoRoot, ['add', 'src/app.ts']);
        const materialized = materializeFullSuiteRepairTask({
            repoRoot,
            taskId: TASK_ID,
            preflightPath,
            fullSuiteArtifactPath: fullSuitePath
        });

        fs.writeFileSync(path.join(repoRoot, 'README.md'), '# Fixture\n\nadvanced\n', 'utf8');
        runGit(repoRoot, ['add', 'README.md']);
        runGit(repoRoot, ['commit', '-m', 'advance base']);
        markRepairChildDone(repoRoot);

        const restored = restoreMaterializedWip({
            repoRoot,
            fullSuitePath,
            manifestPath: materialized.wip_manifest_path || ''
        });

        assert.equal(restored.status, 'RESTORED', restored.output_lines.join('\n'));
        assert.equal(fs.readFileSync(path.join(repoRoot, 'src', 'app.ts'), 'utf8'), 'export const value = 2;\n');
        assert.equal(fs.readFileSync(path.join(repoRoot, 'README.md'), 'utf8'), '# Fixture\n\nadvanced\n');
    });

    it('blocks restore when descendant repair history escapes immutable child scopes', () => {
        const { repoRoot, preflightPath, fullSuitePath } = makeRepo();
        const appPath = path.join(repoRoot, 'src', 'app.ts');
        fs.writeFileSync(appPath, 'export const value = 2;\n', 'utf8');
        runGit(repoRoot, ['add', 'src/app.ts']);
        const materialized = materializeFullSuiteRepairTask({
            repoRoot,
            taskId: TASK_ID,
            preflightPath,
            fullSuiteArtifactPath: fullSuitePath
        });
        assert.equal(materialized.status, 'MATERIALIZED', materialized.output_lines.join('\n'));
        fs.writeFileSync(path.join(repoRoot, 'outside-repair-scope.ts'), 'export const outside = true;\n', 'utf8');
        runGit(repoRoot, ['add', 'outside-repair-scope.ts']);
        runGit(repoRoot, ['commit', '-m', 'escape repair scope']);
        markRepairChildDone(repoRoot);

        const restored = restoreMaterializedWip({
            repoRoot,
            fullSuitePath,
            manifestPath: materialized.wip_manifest_path || ''
        });

        assert.equal(restored.status, 'BLOCKED');
        assert.match(
            restored.violations.join('\n'),
            /history escaped immutable scoped handoff: outside-repair-scope\.ts/
        );
        assert.equal(normalizeNewlines(fs.readFileSync(appPath, 'utf8')), 'export const value = 1;\n');
    });

    it('blocks restore when the repair child commit overlaps a suspended WIP path', () => {
        const { repoRoot, preflightPath, fullSuitePath } = makeRepo();
        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const value = 2;\n', 'utf8');
        runGit(repoRoot, ['add', 'src/app.ts']);
        const materialized = materializeFullSuiteRepairTask({
            repoRoot,
            taskId: TASK_ID,
            preflightPath,
            fullSuiteArtifactPath: fullSuitePath
        });

        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const childValue = 3;\n', 'utf8');
        runGit(repoRoot, ['add', 'src/app.ts']);
        runGit(repoRoot, ['commit', '-m', 'advance overlapping child path']);
        markRepairChildDone(repoRoot);

        const restored = restoreMaterializedWip({
            repoRoot,
            fullSuitePath,
            manifestPath: materialized.wip_manifest_path || ''
        });

        assert.equal(restored.status, 'BLOCKED');
        assert.ok(restored.violations.some((violation) => violation.includes('overlaps suspended WIP path')));
        assert.equal(fs.readFileSync(path.join(repoRoot, 'src', 'app.ts'), 'utf8'), 'export const childValue = 3;\n');
    });

    it('blocks restore when descendant commits modify and then revert a suspended WIP path', () => {
        const { repoRoot, preflightPath, fullSuitePath } = makeRepo();
        const appPath = path.join(repoRoot, 'src', 'app.ts');
        fs.writeFileSync(appPath, 'export const value = 2;\n', 'utf8');
        runGit(repoRoot, ['add', 'src/app.ts']);
        const materialized = materializeFullSuiteRepairTask({
            repoRoot,
            taskId: TASK_ID,
            preflightPath,
            fullSuiteArtifactPath: fullSuitePath
        });

        fs.writeFileSync(appPath, 'export const childValue = 3;\n', 'utf8');
        runGit(repoRoot, ['add', 'src/app.ts']);
        runGit(repoRoot, ['commit', '-m', 'touch suspended path']);
        fs.writeFileSync(appPath, 'export const value = 1;\n', 'utf8');
        runGit(repoRoot, ['add', 'src/app.ts']);
        runGit(repoRoot, ['commit', '-m', 'revert suspended path']);
        markRepairChildDone(repoRoot);

        const restored = restoreMaterializedWip({
            repoRoot,
            fullSuitePath,
            manifestPath: materialized.wip_manifest_path || ''
        });

        assert.equal(restored.status, 'BLOCKED');
        assert.ok(restored.violations.some((violation) => violation.includes('overlaps suspended WIP path')));
        assert.equal(fs.readFileSync(appPath, 'utf8'), 'export const value = 1;\n');
    });

    it('blocks restore when current HEAD is not descended from the manifest base', () => {
        const { repoRoot, preflightPath, fullSuitePath } = makeRepo();
        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const value = 2;\n', 'utf8');
        runGit(repoRoot, ['add', 'src/app.ts']);
        const materialized = materializeFullSuiteRepairTask({
            repoRoot,
            taskId: TASK_ID,
            preflightPath,
            fullSuiteArtifactPath: fullSuitePath
        });
        assert.equal(materialized.status, 'MATERIALIZED', materialized.output_lines.join('\n'));
        runGit(repoRoot, ['checkout', '--orphan', 'unrelated-history']);
        runGit(repoRoot, ['commit', '-m', 'unrelated root']);
        markRepairChildDone(repoRoot);

        const restored = restoreMaterializedWip({
            repoRoot,
            fullSuitePath,
            manifestPath: materialized.wip_manifest_path || ''
        });

        assert.equal(restored.status, 'BLOCKED');
        assert.ok(restored.violations.some((violation) => violation.includes('not an ancestor of current HEAD')));
    });

    it('blocks restore when a merged descendant branch touched and reverted a suspended path', () => {
        const { repoRoot, preflightPath, fullSuitePath } = makeRepo();
        const appPath = path.join(repoRoot, 'src', 'app.ts');
        fs.writeFileSync(appPath, 'export const value = 2;\n', 'utf8');
        runGit(repoRoot, ['add', 'src/app.ts']);
        const materialized = materializeFullSuiteRepairTask({
            repoRoot,
            taskId: TASK_ID,
            preflightPath,
            fullSuiteArtifactPath: fullSuitePath
        });
        assert.equal(materialized.status, 'MATERIALIZED', materialized.output_lines.join('\n'));
        const mainBranch = runGit(repoRoot, ['branch', '--show-current']).trim();
        runGit(repoRoot, ['checkout', '-b', 'repair-history']);
        fs.writeFileSync(appPath, 'export const childValue = 3;\n', 'utf8');
        runGit(repoRoot, ['add', 'src/app.ts']);
        runGit(repoRoot, ['commit', '-m', 'branch touches suspended path']);
        fs.writeFileSync(appPath, 'export const value = 1;\n', 'utf8');
        runGit(repoRoot, ['add', 'src/app.ts']);
        runGit(repoRoot, ['commit', '-m', 'branch reverts suspended path']);
        runGit(repoRoot, ['checkout', mainBranch]);
        fs.writeFileSync(path.join(repoRoot, 'README.md'), '# Fixture\n\nmainline\n', 'utf8');
        runGit(repoRoot, ['add', 'README.md']);
        runGit(repoRoot, ['commit', '-m', 'advance mainline']);
        runGit(repoRoot, ['merge', '--no-ff', 'repair-history', '-m', 'merge repair history']);
        markRepairChildDone(repoRoot);

        const restored = restoreMaterializedWip({
            repoRoot,
            fullSuitePath,
            manifestPath: materialized.wip_manifest_path || ''
        });

        assert.equal(restored.status, 'BLOCKED');
        assert.ok(restored.violations.some((violation) => violation.includes('overlaps suspended WIP path')));
        assert.equal(fs.readFileSync(appPath, 'utf8'), 'export const value = 1;\n');
    });

    it('treats a leading-dash tracked filename as a literal descendant-history path', () => {
        const { repoRoot, preflightPath, fullSuitePath } = makeRepo();
        const leadingDashPath = path.join(repoRoot, '-suspended.ts');
        fs.writeFileSync(leadingDashPath, 'export const value = 1;\n', 'utf8');
        runGit(repoRoot, ['add', '--', '-suspended.ts']);
        runGit(repoRoot, ['commit', '-m', 'seed leading dash path']);
        const preflight = readJson(preflightPath);
        preflight.changed_files = ['-suspended.ts'];
        writeJson(preflightPath, preflight);
        fs.writeFileSync(leadingDashPath, 'export const parentValue = 2;\n', 'utf8');
        runGit(repoRoot, ['add', '--', '-suspended.ts']);
        const materialized = materializeFullSuiteRepairTask({
            repoRoot,
            taskId: TASK_ID,
            preflightPath,
            fullSuiteArtifactPath: fullSuitePath
        });
        assert.equal(materialized.status, 'MATERIALIZED', materialized.output_lines.join('\n'));
        fs.writeFileSync(leadingDashPath, 'export const childValue = 3;\n', 'utf8');
        runGit(repoRoot, ['add', '--', '-suspended.ts']);
        runGit(repoRoot, ['commit', '-m', 'touch leading dash suspended path']);
        markRepairChildDone(repoRoot);

        const restored = restoreMaterializedWip({
            repoRoot,
            fullSuitePath,
            manifestPath: materialized.wip_manifest_path || ''
        });

        assert.equal(restored.status, 'BLOCKED');
        assert.ok(restored.violations.some((violation) => violation.includes('overlaps suspended WIP path: -suspended.ts')));
        assert.equal(fs.readFileSync(leadingDashPath, 'utf8'), 'export const childValue = 3;\n');
    });

    it('restores a staged binary patch whose path contains spaces', () => {
        const { repoRoot, preflightPath, fullSuitePath } = makeRepo();
        const relativePath = 'src/binary payload.bin';
        const binaryPath = path.join(repoRoot, relativePath);
        fs.writeFileSync(binaryPath, Buffer.from([0, 1, 2, 3, 4]));
        runGit(repoRoot, ['add', '--', relativePath]);
        runGit(repoRoot, ['commit', '-m', 'seed binary payload']);
        const preflight = readJson(preflightPath);
        preflight.changed_files = [relativePath];
        writeJson(preflightPath, preflight);
        const restoredBytes = Buffer.from([0, 255, 2, 9, 4, 7]);
        fs.writeFileSync(binaryPath, restoredBytes);
        runGit(repoRoot, ['add', '--', relativePath]);
        const materialized = materializeFullSuiteRepairTask({
            repoRoot,
            taskId: TASK_ID,
            preflightPath,
            fullSuiteArtifactPath: fullSuitePath
        });
        assert.equal(materialized.status, 'MATERIALIZED', materialized.output_lines.join('\n'));
        markRepairChildDone(repoRoot);

        const restored = restoreMaterializedWip({
            repoRoot,
            fullSuitePath,
            manifestPath: materialized.wip_manifest_path || ''
        });

        assert.equal(restored.status, 'RESTORED', restored.output_lines.join('\n'));
        assert.deepEqual(fs.readFileSync(binaryPath), restoredBytes);
        assert.equal(runGit(repoRoot, ['diff', '--cached', '--name-only', '--', relativePath]).trim(), relativePath);
    });

    it('restores a staged rename plus an unstaged edit from NUL rename records', () => {
        const { repoRoot, preflightPath, fullSuitePath } = makeRepo();
        const previousPath = 'src/rename-before.ts';
        const nextPath = 'src/rename-after.ts';
        fs.writeFileSync(path.join(repoRoot, previousPath), 'export const value = 1;\n', 'utf8');
        runGit(repoRoot, ['add', '--', previousPath]);
        runGit(repoRoot, ['commit', '-m', 'seed rename source']);
        const preflight = readJson(preflightPath);
        preflight.changed_files = [previousPath, nextPath];
        writeJson(preflightPath, preflight);
        runGit(repoRoot, ['mv', '--', previousPath, nextPath]);
        fs.writeFileSync(path.join(repoRoot, nextPath), 'export const value = 2;\n', 'utf8');
        const materialized = materializeFullSuiteRepairTask({
            repoRoot,
            taskId: TASK_ID,
            preflightPath,
            fullSuiteArtifactPath: fullSuitePath
        });
        assert.equal(materialized.status, 'MATERIALIZED', materialized.output_lines.join('\n'));
        markRepairChildDone(repoRoot);

        const restored = restoreMaterializedWip({
            repoRoot,
            fullSuitePath,
            manifestPath: materialized.wip_manifest_path || ''
        });

        assert.equal(restored.status, 'RESTORED', restored.output_lines.join('\n'));
        assert.equal(fs.existsSync(path.join(repoRoot, previousPath)), false);
        assert.equal(fs.readFileSync(path.join(repoRoot, nextPath), 'utf8'), 'export const value = 2;\n');
        assert.match(runGit(repoRoot, ['diff', '--cached', '--summary']), /rename src\/\{rename-before\.ts => rename-after\.ts\}/);
        assert.match(runGit(repoRoot, ['diff', '--', nextPath]), /[-]export const value = 1;[\s\S]*[+]export const value = 2;/);
    });

    it('blocks an unbound copy source and restores a fully bound real Git C-octal copy patch', () => {
        const { repoRoot, preflightPath, fullSuitePath } = makeRepo();
        const quotedSegment = process.platform === 'win32' ? '' : ' "quoted"';
        const sourcePath = `src/cøpy source${quotedSegment}.ts`;
        const destinationPath = `src/cøpy target${quotedSegment}.ts`;
        const sourceBytes = 'export const copied = "C-octal path";\n';
        fs.mkdirSync(path.dirname(path.join(repoRoot, sourcePath)), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, sourcePath), sourceBytes, 'utf8');
        runGit(repoRoot, ['add', '--', sourcePath]);
        runGit(repoRoot, ['commit', '-m', 'seed quoted Unicode copy source']);
        const preflight = readJson(preflightPath);
        preflight.changed_files = [destinationPath];
        writeJson(preflightPath, preflight);
        fs.copyFileSync(path.join(repoRoot, sourcePath), path.join(repoRoot, destinationPath));
        runGit(repoRoot, ['add', '--', destinationPath]);
        const copyPatch = runGit(repoRoot, [
            'diff',
            '--binary',
            '--cached',
            '-C',
            '--find-copies-harder',
            '--',
            sourcePath,
            destinationPath
        ]);
        assert.match(copyPatch, /copy from /);
        assert.match(copyPatch, /copy to /);
        assert.match(copyPatch, /\\303\\270/u);
        if (quotedSegment) {
            assert.match(copyPatch, /\\"quoted\\"/u);
        }

        const materialized = materializeFullSuiteRepairTask({
            repoRoot,
            taskId: TASK_ID,
            preflightPath,
            fullSuiteArtifactPath: fullSuitePath
        });
        assert.equal(materialized.status, 'MATERIALIZED', materialized.output_lines.join('\n'));
        const manifestPath = materialized.wip_manifest_path || '';
        const manifest = readJson(manifestPath);
        const stagedPatch = (manifest.patches as Record<string, Record<string, unknown>>).staged;
        const stagedPatchPath = String(stagedPatch.path);
        fs.writeFileSync(stagedPatchPath, copyPatch, 'utf8');
        stagedPatch.sha256 = fileSha256(stagedPatchPath);
        stagedPatch.bytes = Buffer.byteLength(copyPatch);
        stagedPatch.empty = false;
        writeJson(manifestPath, manifest);
        refreshMaterializationManifestSha(repoRoot, manifestPath);
        markRepairChildDone(repoRoot);

        const unboundCopy = restoreMaterializedWip({
            repoRoot,
            fullSuitePath,
            manifestPath
        });
        assert.equal(unboundCopy.status, 'BLOCKED');
        assert.ok(unboundCopy.violations.some((violation) => violation.includes('changed paths are not bound by tracked_files')));

        const trackedFiles = manifest.tracked_files as Array<Record<string, unknown>>;
        trackedFiles.push({
            path: sourcePath,
            head_sha256: runGit(repoRoot, ['rev-parse', `HEAD:${sourcePath}`]).trim(),
            worktree_sha256: fileSha256(path.join(repoRoot, sourcePath)),
            staged: true,
            unstaged: false
        });
        writeJson(manifestPath, manifest);
        refreshMaterializationManifestSha(repoRoot, manifestPath);
        const restored = restoreMaterializedWip({
            repoRoot,
            fullSuitePath,
            manifestPath
        });

        assert.equal(restored.status, 'RESTORED', restored.output_lines.join('\n'));
        assert.equal(fs.readFileSync(path.join(repoRoot, destinationPath), 'utf8'), sourceBytes);
        assert.ok(runGit(repoRoot, ['diff', '--cached', '--name-only', '-z']).split('\0').includes(destinationPath));
    });

    it('blocks malformed restore manifests instead of skipping base and tracked-file checks', () => {
        const { repoRoot, preflightPath, fullSuitePath } = makeRepo();
        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const value = 2;\n', 'utf8');
        runGit(repoRoot, ['add', 'src/app.ts']);
        const materialized = materializeFullSuiteRepairTask({
            repoRoot,
            taskId: TASK_ID,
            preflightPath,
            fullSuiteArtifactPath: fullSuitePath
        });
        const manifestPath = materialized.wip_manifest_path || '';
        const originalManifest = readJson(manifestPath);
        markRepairChildDone(repoRoot);

        writeJson(manifestPath, { ...originalManifest, base_commit: '' });
        refreshMaterializationManifestSha(repoRoot, manifestPath);
        const missingBase = restoreMaterializedWip({
            repoRoot,
            fullSuitePath,
            manifestPath
        });
        assert.equal(missingBase.status, 'BLOCKED');
        assert.ok(missingBase.violations.some((violation) => violation.includes('base_commit')));

        writeJson(manifestPath, { ...originalManifest, tracked_files: null });
        refreshMaterializationManifestSha(repoRoot, manifestPath);
        const malformedTrackedFiles = restoreMaterializedWip({
            repoRoot,
            fullSuitePath,
            manifestPath
        });
        assert.equal(malformedTrackedFiles.status, 'BLOCKED');
        assert.ok(malformedTrackedFiles.violations.some((violation) => violation.includes('tracked_files must be an array')));

        writeJson(manifestPath, { ...originalManifest, tracked_files: [] });
        refreshMaterializationManifestSha(repoRoot, manifestPath);
        const unboundPatchPaths = restoreMaterializedWip({
            repoRoot,
            fullSuitePath,
            manifestPath
        });
        assert.equal(unboundPatchPaths.status, 'BLOCKED');
        assert.ok(unboundPatchPaths.violations.some((violation) => violation.includes('no bound tracked_files entries')));

        const originalTrackedFiles = originalManifest.tracked_files as Array<Record<string, unknown>>;
        writeJson(manifestPath, {
            ...originalManifest,
            tracked_files: [{ ...originalTrackedFiles[0], path: 'src/tab\tname.ts' }]
        });
        refreshMaterializationManifestSha(repoRoot, manifestPath);
        const unsupportedControlPath = restoreMaterializedWip({
            repoRoot,
            fullSuitePath,
            manifestPath
        });
        assert.equal(unsupportedControlPath.status, 'BLOCKED');
        assert.ok(unsupportedControlPath.violations.some((violation) => violation.includes('safe repository-relative path')));
    });

    it('rejects malformed schema-v3 timestamps, bindings, tracked hashes, and duplicate untracked paths', () => {
        const { repoRoot, preflightPath, fullSuitePath } = makeRepo();
        const appPath = path.join(repoRoot, 'src', 'app.ts');
        const helperPath = path.join(repoRoot, 'src', 'new-helper.ts');
        fs.writeFileSync(appPath, 'export const value = 2;\n', 'utf8');
        runGit(repoRoot, ['add', 'src/app.ts']);
        fs.writeFileSync(helperPath, 'export const helper = true;\n', 'utf8');
        const preflight = readJson(preflightPath);
        preflight.changed_files = ['src/app.ts', 'src/new-helper.ts'];
        writeJson(preflightPath, preflight);
        const materialized = materializeFullSuiteRepairTask({
            repoRoot,
            taskId: TASK_ID,
            preflightPath,
            fullSuiteArtifactPath: fullSuitePath
        });
        assert.equal(materialized.status, 'MATERIALIZED', materialized.output_lines.join('\n'));
        const manifestPath = materialized.wip_manifest_path || '';
        const manifest = readJson(manifestPath);
        const trackedFiles = manifest.tracked_files as Array<Record<string, unknown>>;
        const untrackedFiles = manifest.untracked_files as Array<Record<string, unknown>>;
        manifest.created_at_utc = '2026-07-26';
        manifest.preflight_path = '../outside-preflight.json';
        manifest.preflight_sha256 = 'not-a-sha256';
        manifest.full_suite_artifact_path = '../outside-full-suite.json';
        manifest.full_suite_artifact_sha256 = 'not-a-sha256';
        trackedFiles[0].head_sha256 = 'abc';
        trackedFiles[0].worktree_sha256 = 'def';
        manifest.untracked_files = [untrackedFiles[0], { ...untrackedFiles[0] }];
        writeJson(manifestPath, manifest);
        refreshMaterializationManifestSha(repoRoot, manifestPath);
        markRepairChildDone(repoRoot);

        const restored = restoreMaterializedWip({
            repoRoot,
            fullSuitePath,
            manifestPath
        });

        assert.equal(restored.status, 'BLOCKED');
        for (const expected of [
            'created_at_utc must be a canonical ISO-8601 UTC timestamp',
            'preflight_path',
            'preflight_sha256 must be a 64-character SHA-256 value',
            'full_suite_artifact_path',
            'full_suite_artifact_sha256 must be a 64-character SHA-256 value',
            'head_sha256 must be null or a full Git object id',
            'worktree_sha256 must be null or a 64-character SHA-256 value',
            'untracked_files contains duplicate path'
        ]) {
            assert.ok(restored.violations.some((violation) => violation.includes(expected)), expected);
        }
    });

    it('rejects materialization evidence when the final manifest has an additional hard link', () => {
        const { repoRoot, preflightPath, fullSuitePath } = makeRepo();
        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const value = 2;\n', 'utf8');
        runGit(repoRoot, ['add', 'src/app.ts']);
        const materialized = materializeFullSuiteRepairTask({
            repoRoot,
            taskId: TASK_ID,
            preflightPath,
            fullSuiteArtifactPath: fullSuitePath
        });
        assert.equal(materialized.status, 'MATERIALIZED', materialized.output_lines.join('\n'));
        const manifestPath = materialized.wip_manifest_path || '';
        fs.linkSync(manifestPath, `${manifestPath}.hardlink`);

        const evidence = readFullSuiteRepairTaskMaterializationEvidence({
            repoRoot,
            reviewsRoot: path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews'),
            taskId: TASK_ID,
            fullSuiteArtifactPath: fullSuitePath,
            childTaskId: CHILD_TASK_ID
        });

        assert.equal(evidence.materialized, false);
        assert.ok(evidence.reason.includes('additional hard links'), evidence.reason);
    });

    it('rejects a materialization artifact reached through an external junction or symbolic-link ancestor', () => {
        const { repoRoot, preflightPath, fullSuitePath } = makeRepo();
        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const value = 2;\n', 'utf8');
        runGit(repoRoot, ['add', 'src/app.ts']);
        const materialized = materializeFullSuiteRepairTask({
            repoRoot,
            taskId: TASK_ID,
            preflightPath,
            fullSuiteArtifactPath: fullSuitePath
        });
        assert.equal(materialized.status, 'MATERIALIZED', materialized.output_lines.join('\n'));
        const reviewsRoot = path.dirname(materialized.artifact_path);
        const externalRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-full-suite-reviews-external-'));
        tempRoots.push(externalRoot);
        const externalReviewsRoot = path.join(externalRoot, 'reviews');
        fs.cpSync(reviewsRoot, externalReviewsRoot, { recursive: true });
        fs.rmSync(reviewsRoot, { recursive: true, force: true });
        fs.symlinkSync(externalReviewsRoot, reviewsRoot, process.platform === 'win32' ? 'junction' : 'dir');

        const evidence = readFullSuiteRepairTaskMaterializationEvidence({
            repoRoot,
            reviewsRoot,
            taskId: TASK_ID,
            fullSuiteArtifactPath: fullSuitePath,
            childTaskId: CHILD_TASK_ID
        });

        assert.equal(evidence.materialized, false);
        assert.ok(
            evidence.reason.includes('physical repository boundary')
            || evidence.reason.includes('symbolic-link or junction'),
            evidence.reason
        );
    });

    it('rejects a rebound manifest outside its canonical timestamped capture leaf', () => {
        const { repoRoot, preflightPath, fullSuitePath } = makeRepo();
        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const value = 2;\n', 'utf8');
        runGit(repoRoot, ['add', 'src/app.ts']);
        const materialized = materializeFullSuiteRepairTask({
            repoRoot,
            taskId: TASK_ID,
            preflightPath,
            fullSuiteArtifactPath: fullSuitePath
        });
        assert.equal(materialized.status, 'MATERIALIZED', materialized.output_lines.join('\n'));
        const originalManifestPath = materialized.wip_manifest_path || '';
        const reboundManifestPath = path.join(
            path.dirname(path.dirname(originalManifestPath)),
            'rebound',
            'manifest.json'
        );
        fs.mkdirSync(path.dirname(reboundManifestPath), { recursive: true });
        fs.copyFileSync(originalManifestPath, reboundManifestPath);
        const repairArtifact = readJson(materialized.artifact_path);
        repairArtifact.wip_manifest_path = normalizeForArtifact(reboundManifestPath);
        repairArtifact.wip_manifest_sha256 = fileSha256(reboundManifestPath);
        writeJson(materialized.artifact_path, repairArtifact);

        const evidence = readFullSuiteRepairTaskMaterializationEvidence({
            repoRoot,
            reviewsRoot: path.dirname(materialized.artifact_path),
            taskId: TASK_ID,
            fullSuiteArtifactPath: fullSuitePath,
            childTaskId: CHILD_TASK_ID
        });

        assert.equal(evidence.materialized, false);
        assert.ok(evidence.reason.includes('canonical capture leaf'), evidence.reason);
    });

    it('rejects patch and untracked artifacts rebound outside their canonical capture leaf', () => {
        const { repoRoot, preflightPath, fullSuitePath } = makeRepo();
        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const value = 2;\n', 'utf8');
        runGit(repoRoot, ['add', 'src/app.ts']);
        const helperPath = path.join(repoRoot, 'src', 'new-helper.ts');
        fs.writeFileSync(helperPath, 'export const helper = true;\n', 'utf8');
        const preflight = readJson(preflightPath);
        preflight.changed_files = ['src/app.ts', 'src/new-helper.ts'];
        writeJson(preflightPath, preflight);
        const materialized = materializeFullSuiteRepairTask({
            repoRoot,
            taskId: TASK_ID,
            preflightPath,
            fullSuiteArtifactPath: fullSuitePath
        });
        assert.equal(materialized.status, 'MATERIALIZED', materialized.output_lines.join('\n'));
        const manifestPath = materialized.wip_manifest_path || '';
        const manifest = readJson(manifestPath);
        const patches = manifest.patches as Record<string, Record<string, unknown>>;
        const untrackedFiles = manifest.untracked_files as Array<Record<string, unknown>>;
        const detachedRoot = path.join(
            repoRoot,
            'garda-agent-orchestrator',
            'runtime',
            'wip',
            'detached-artifacts'
        );
        fs.mkdirSync(detachedRoot, { recursive: true });
        const detachedPatchPath = path.join(detachedRoot, 'staged.patch');
        const detachedUntrackedPath = path.join(detachedRoot, 'new-helper.ts');
        fs.copyFileSync(String(patches.staged.path), detachedPatchPath);
        fs.copyFileSync(String(untrackedFiles[0].artifact_path), detachedUntrackedPath);
        patches.staged.path = normalizeForArtifact(detachedPatchPath);
        untrackedFiles[0].artifact_path = normalizeForArtifact(detachedUntrackedPath);
        writeJson(manifestPath, manifest);
        refreshMaterializationManifestSha(repoRoot, manifestPath);
        markRepairChildDone(repoRoot);

        const restored = restoreMaterializedWip({
            repoRoot,
            fullSuitePath,
            manifestPath
        });

        assert.equal(restored.status, 'BLOCKED');
        assert.ok(restored.violations.some((violation) => (
            violation.includes('staged patch path')
            && violation.includes('canonical capture artifact')
        )));
        assert.ok(restored.violations.some((violation) => (
            violation.includes('untracked_files[0].artifact_path')
            && violation.includes('canonical capture artifact')
        )));
    });

    it('blocks restore when a final patch artifact has an additional hard link', () => {
        const { repoRoot, preflightPath, fullSuitePath } = makeRepo();
        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const value = 2;\n', 'utf8');
        runGit(repoRoot, ['add', 'src/app.ts']);
        const materialized = materializeFullSuiteRepairTask({
            repoRoot,
            taskId: TASK_ID,
            preflightPath,
            fullSuiteArtifactPath: fullSuitePath
        });
        assert.equal(materialized.status, 'MATERIALIZED', materialized.output_lines.join('\n'));
        const manifestPath = materialized.wip_manifest_path || '';
        const manifest = readJson(manifestPath);
        const stagedPatchPath = String((manifest.patches as Record<string, Record<string, unknown>>).staged.path);
        fs.linkSync(stagedPatchPath, `${stagedPatchPath}.hardlink`);
        markRepairChildDone(repoRoot);

        const restored = restoreMaterializedWip({
            repoRoot,
            fullSuitePath,
            manifestPath
        });

        assert.equal(restored.status, 'BLOCKED');
        assert.ok(restored.violations.some((violation) => (
            violation.includes('staged patch artifact')
            && violation.includes('additional hard links')
        )));
    });

    it('rejects option-like patch artifact paths before invoking git apply', () => {
        const { repoRoot, preflightPath, fullSuitePath } = makeRepo();
        const appPath = path.join(repoRoot, 'src', 'app.ts');
        fs.writeFileSync(appPath, 'export const value = 2;\n', 'utf8');
        runGit(repoRoot, ['add', 'src/app.ts']);
        const materialized = materializeFullSuiteRepairTask({
            repoRoot,
            taskId: TASK_ID,
            preflightPath,
            fullSuiteArtifactPath: fullSuitePath
        });
        assert.equal(materialized.status, 'MATERIALIZED', materialized.output_lines.join('\n'));
        const manifestPath = materialized.wip_manifest_path || '';
        const manifest = readJson(manifestPath);
        const patches = manifest.patches as Record<string, Record<string, unknown>>;
        const stagedPatch = patches.staged;
        const optionLikePath = path.join(repoRoot, '--allow-empty');
        fs.copyFileSync(String(stagedPatch.path), optionLikePath);
        stagedPatch.path = '--allow-empty';
        writeJson(manifestPath, manifest);
        refreshMaterializationManifestSha(repoRoot, manifestPath);
        markRepairChildDone(repoRoot);

        const restored = restoreMaterializedWip({
            repoRoot,
            fullSuitePath,
            manifestPath
        });

        assert.equal(restored.status, 'BLOCKED');
        assert.ok(restored.violations.some((violation) => violation.includes('option-like relative path')));
        assert.equal(fs.readFileSync(appPath, 'utf8'), 'export const value = 1;\n');
        assert.equal(runGit(repoRoot, ['diff', '--name-only', '--cached']).trim(), '');
    });

    it('blocks restore when tracked workspace changes would conflict with the suspended WIP', () => {
        const { repoRoot, preflightPath, fullSuitePath } = makeRepo();
        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const value = 2;\n', 'utf8');
        runGit(repoRoot, ['add', 'src/app.ts']);
        const materialized = materializeFullSuiteRepairTask({
            repoRoot,
            taskId: TASK_ID,
            preflightPath,
            fullSuiteArtifactPath: fullSuitePath
        });

        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const value = 99;\n', 'utf8');
        const restored = restoreMaterializedWip({
            repoRoot,
            fullSuitePath,
            manifestPath: materialized.wip_manifest_path || ''
        });

        assert.equal(restored.status, 'BLOCKED');
        assert.ok(restored.violations.some((violation) => violation.includes('unstaged tracked changes exist')));
    });

    it('blocks restore when a captured patch artifact hash changed', () => {
        const { repoRoot, preflightPath, fullSuitePath } = makeRepo();
        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const value = 2;\n', 'utf8');
        runGit(repoRoot, ['add', 'src/app.ts']);
        const materialized = materializeFullSuiteRepairTask({
            repoRoot,
            taskId: TASK_ID,
            preflightPath,
            fullSuiteArtifactPath: fullSuitePath
        });
        assert.equal(materialized.status, 'MATERIALIZED', materialized.output_lines.join('\n'));

        const manifest = readJson(materialized.wip_manifest_path || '');
        const patches = manifest.patches as Record<string, Record<string, unknown>>;
        fs.writeFileSync(String(patches.staged.path), 'tampered patch\n', 'utf8');

        const restored = restoreMaterializedWip({
            repoRoot,
            fullSuitePath,
            manifestPath: materialized.wip_manifest_path || ''
        });

        assert.equal(restored.status, 'BLOCKED');
        assert.ok(restored.violations.some((violation) => violation.includes('staged patch sha256 mismatch')));
    });

    it('applies the validated patch snapshot when the artifact path is replaced before mutation', () => {
        const { repoRoot, preflightPath, fullSuitePath } = makeRepo();
        const appPath = path.join(repoRoot, 'src', 'app.ts');
        fs.writeFileSync(appPath, 'export const value = 2;\n', 'utf8');
        runGit(repoRoot, ['add', 'src/app.ts']);
        const materialized = materializeFullSuiteRepairTask({
            repoRoot,
            taskId: TASK_ID,
            preflightPath,
            fullSuiteArtifactPath: fullSuitePath
        });
        assert.equal(materialized.status, 'MATERIALIZED', materialized.output_lines.join('\n'));
        const manifest = readJson(materialized.wip_manifest_path || '');
        const stagedPatchPath = String((manifest.patches as Record<string, Record<string, unknown>>).staged.path);
        fs.writeFileSync(appPath, 'export const value = 999;\n', 'utf8');
        const replacementPatch = runGit(repoRoot, ['diff', '--binary', '--', 'src/app.ts']);
        fs.writeFileSync(appPath, 'export const value = 1;\n', 'utf8');
        markRepairChildDone(repoRoot);

        const fsModule = require('node:fs') as typeof import('node:fs');
        const originalOpenSync = fsModule.openSync;
        const originalCloseSync = fsModule.closeSync;
        const originalWriteFileSync = fsModule.writeFileSync;
        const stagedPatchDescriptors = new Set<number>();
        let stagedPatchSnapshots = 0;
        fsModule.openSync = ((filePath: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
            const descriptor = originalOpenSync(filePath, flags, mode);
            if (path.resolve(String(filePath)) === path.resolve(stagedPatchPath)) {
                stagedPatchDescriptors.add(descriptor);
            }
            return descriptor;
        }) as typeof fsModule.openSync;
        fsModule.closeSync = ((descriptor: number) => {
            originalCloseSync(descriptor);
            if (stagedPatchDescriptors.delete(descriptor)) {
                stagedPatchSnapshots += 1;
                if (stagedPatchSnapshots === 2) {
                    originalWriteFileSync(stagedPatchPath, replacementPatch, 'utf8');
                }
            }
        }) as typeof fsModule.closeSync;
        let restored: ReturnType<typeof restoreMaterializedWip> | null = null;
        try {
            restored = restoreMaterializedWip({
                repoRoot,
                fullSuitePath,
                manifestPath: materialized.wip_manifest_path || ''
            });
        } finally {
            fsModule.openSync = originalOpenSync;
            fsModule.closeSync = originalCloseSync;
        }

        assert.equal(stagedPatchSnapshots, 2);
        assert.equal(restored?.status, 'RESTORED', restored?.output_lines.join('\n'));
        assert.equal(fs.readFileSync(appPath, 'utf8'), 'export const value = 2;\n');
        assert.match(runGit(repoRoot, ['diff', '--cached', '--', 'src/app.ts']), /\+export const value = 2;/);
        assert.doesNotMatch(runGit(repoRoot, ['diff', '--cached', '--', 'src/app.ts']), /999/);
    });

    it('blocks restore when a captured untracked artifact hash changed', () => {
        const { repoRoot, preflightPath, fullSuitePath } = makeRepo();
        const scratchPath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'tmp', `${TASK_ID}-scratch.log`);
        fs.mkdirSync(path.dirname(scratchPath), { recursive: true });
        fs.writeFileSync(scratchPath, 'scratch parent WIP\n', 'utf8');
        const materialized = materializeFullSuiteRepairTask({
            repoRoot,
            taskId: TASK_ID,
            preflightPath,
            fullSuiteArtifactPath: fullSuitePath
        });
        assert.equal(materialized.status, 'MATERIALIZED', materialized.output_lines.join('\n'));

        const manifest = readJson(materialized.wip_manifest_path || '');
        const untrackedFiles = manifest.untracked_files as Array<Record<string, unknown>>;
        fs.writeFileSync(String(untrackedFiles[0].artifact_path), 'tampered scratch\n', 'utf8');

        const restored = restoreMaterializedWip({
            repoRoot,
            fullSuitePath,
            manifestPath: materialized.wip_manifest_path || ''
        });

        assert.equal(restored.status, 'BLOCKED');
        assertBlockedOperatorOutputHasNoNavigatorCommand(restored.output_lines);
        assert.ok(restored.violations.some((violation) => violation.includes('untracked artifact garda-agent-orchestrator/runtime/tmp/T-FULL-SUITE-REPAIR-scratch.log sha256 mismatch')));
    });

    it('restores untracked files from repo-root-resolved artifact paths', () => {
        const { repoRoot, preflightPath, fullSuitePath } = makeRepo();
        const scratchPath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'tmp', `${TASK_ID}-scratch.log`);
        fs.mkdirSync(path.dirname(scratchPath), { recursive: true });
        fs.writeFileSync(scratchPath, 'real scratch parent WIP\n', 'utf8');
        const materialized = materializeFullSuiteRepairTask({
            repoRoot,
            taskId: TASK_ID,
            preflightPath,
            fullSuiteArtifactPath: fullSuitePath
        });
        assert.equal(materialized.status, 'MATERIALIZED', materialized.output_lines.join('\n'));
        markRepairChildDone(repoRoot);

        const manifestPath = materialized.wip_manifest_path || '';
        const manifest = readJson(manifestPath);
        const untrackedFiles = manifest.untracked_files as Array<Record<string, unknown>>;
        const relativeArtifactPath = normalizeForArtifact(path.relative(repoRoot, String(untrackedFiles[0].artifact_path)));
        untrackedFiles[0].artifact_path = relativeArtifactPath;
        writeJson(manifestPath, manifest);
        refreshMaterializationManifestSha(repoRoot, manifestPath);

        const previousCwd = process.cwd();
        const fakeCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-fake-cwd-'));
        tempRoots.push(fakeCwd);
        const fakeArtifactPath = path.join(fakeCwd, relativeArtifactPath);
        fs.mkdirSync(path.dirname(fakeArtifactPath), { recursive: true });
        fs.writeFileSync(fakeArtifactPath, 'forged cwd scratch\n', 'utf8');
        try {
            process.chdir(fakeCwd);
            const restored = restoreMaterializedWip({
                repoRoot,
                fullSuitePath,
                manifestPath
            });

            assert.equal(restored.status, 'RESTORED', restored.output_lines.join('\n'));
            assert.equal(fs.readFileSync(scratchPath, 'utf8'), 'real scratch parent WIP\n');
        } finally {
            process.chdir(previousCwd);
        }
    });

    it('rejects materialization evidence when the WIP manifest hash changed', () => {
        const { repoRoot, preflightPath, fullSuitePath } = makeRepo();
        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const value = 2;\n', 'utf8');
        runGit(repoRoot, ['add', 'src/app.ts']);
        const materialized = materializeFullSuiteRepairTask({
            repoRoot,
            taskId: TASK_ID,
            preflightPath,
            fullSuiteArtifactPath: fullSuitePath
        });
        assert.equal(materialized.status, 'MATERIALIZED', materialized.output_lines.join('\n'));
        assert.ok(materialized.wip_manifest_path);

        const manifest = readJson(materialized.wip_manifest_path || '');
        manifest.status = 'suspended';
        manifest.tampered = true;
        writeJson(materialized.wip_manifest_path || '', manifest);

        const evidence = readFullSuiteRepairTaskMaterializationEvidence({
            repoRoot,
            reviewsRoot: path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews'),
            taskId: TASK_ID,
            fullSuiteArtifactPath: fullSuitePath,
            childTaskId: CHILD_TASK_ID
        });

        assert.equal(evidence.materialized, false);
        assert.equal(evidence.reason, 'full-suite repair WIP manifest sha256 mismatch');
    });

    it('rejects legacy singular child_task_id materialization evidence', () => {
        const { repoRoot, preflightPath, fullSuitePath } = makeRepo();
        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const value = 2;\n', 'utf8');
        runGit(repoRoot, ['add', 'src/app.ts']);
        const materialized = materializeFullSuiteRepairTask({
            repoRoot,
            taskId: TASK_ID,
            preflightPath,
            fullSuiteArtifactPath: fullSuitePath
        });
        assert.equal(materialized.status, 'MATERIALIZED', materialized.output_lines.join('\n'));
        const artifactPath = path.join(
            repoRoot,
            'garda-agent-orchestrator',
            'runtime',
            'reviews',
            `${TASK_ID}-full-suite-repair-task.json`
        );
        const artifact = readJson(artifactPath);
        delete artifact.child_task_ids;
        artifact.child_task_id = CHILD_TASK_ID;
        writeJson(artifactPath, artifact);

        const evidence = readFullSuiteRepairTaskMaterializationEvidence({
            repoRoot,
            reviewsRoot: path.dirname(artifactPath),
            taskId: TASK_ID,
            fullSuiteArtifactPath: fullSuitePath,
            childTaskId: CHILD_TASK_ID
        });

        assert.equal(evidence.materialized, false);
        assert.match(evidence.reason, /requires at least two unique child_task_ids/);
    });

    it('blocks when the manifest path is replaced after materialization validation', () => {
        const { repoRoot, preflightPath, fullSuitePath } = makeRepo();
        const appPath = path.join(repoRoot, 'src', 'app.ts');
        fs.writeFileSync(appPath, 'export const value = 2;\n', 'utf8');
        runGit(repoRoot, ['add', 'src/app.ts']);
        const materialized = materializeFullSuiteRepairTask({
            repoRoot,
            taskId: TASK_ID,
            preflightPath,
            fullSuiteArtifactPath: fullSuitePath
        });
        assert.equal(materialized.status, 'MATERIALIZED', materialized.output_lines.join('\n'));
        const manifestPath = materialized.wip_manifest_path || '';
        const replacementManifest = {
            ...readJson(manifestPath),
            child_task_ids: ['T-UNAUTHORIZED-CHILD', SECOND_CHILD_TASK_ID]
        };
        markRepairChildDone(repoRoot);

        const fsModule = require('node:fs') as typeof import('node:fs');
        const originalOpenSync = fsModule.openSync;
        const originalCloseSync = fsModule.closeSync;
        const originalWriteFileSync = fsModule.writeFileSync;
        const manifestDescriptors = new Set<number>();
        let manifestSnapshots = 0;
        fsModule.openSync = ((filePath: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
            const descriptor = originalOpenSync(filePath, flags, mode);
            if (path.resolve(String(filePath)) === path.resolve(manifestPath)) {
                manifestDescriptors.add(descriptor);
            }
            return descriptor;
        }) as typeof fsModule.openSync;
        fsModule.closeSync = ((descriptor: number) => {
            originalCloseSync(descriptor);
            if (manifestDescriptors.delete(descriptor)) {
                manifestSnapshots += 1;
                if (manifestSnapshots === 1) {
                    originalWriteFileSync(manifestPath, `${JSON.stringify(replacementManifest, null, 2)}\n`, 'utf8');
                }
            }
        }) as typeof fsModule.closeSync;
        let restored: ReturnType<typeof restoreMaterializedWip> | null = null;
        try {
            restored = restoreMaterializedWip({
                repoRoot,
                fullSuitePath,
                manifestPath
            });
        } finally {
            fsModule.openSync = originalOpenSync;
            fsModule.closeSync = originalCloseSync;
        }

        assert.equal(manifestSnapshots, 2);
        assert.equal(restored?.status, 'BLOCKED');
        assert.ok(restored?.violations.some((violation) => violation.includes('changed after materialization validation')));
        assert.equal(fs.readFileSync(appPath, 'utf8'), 'export const value = 1;\n');
        assert.equal(runGit(repoRoot, ['diff', '--name-only', '--cached']).trim(), '');
    });

    it('blocks restore before applying WIP when the parent row cannot be resumed', () => {
        const { repoRoot, preflightPath, fullSuitePath } = makeRepo();
        const appPath = path.join(repoRoot, 'src', 'app.ts');
        fs.writeFileSync(appPath, 'export const value = 2;\n', 'utf8');
        runGit(repoRoot, ['add', 'src/app.ts']);
        const materialized = materializeFullSuiteRepairTask({
            repoRoot,
            taskId: TASK_ID,
            preflightPath,
            fullSuiteArtifactPath: fullSuitePath
        });
        assert.equal(materialized.status, 'MATERIALIZED', materialized.output_lines.join('\n'));
        markRepairChildDone(repoRoot);
        setTaskStatus(repoRoot, TASK_ID, 'TODO');

        const restored = restoreMaterializedWip({
            repoRoot,
            fullSuitePath,
            manifestPath: materialized.wip_manifest_path || ''
        });

        assert.equal(restored.status, 'BLOCKED');
        assert.deepEqual(restored.restored_files, []);
        assert.ok(restored.violations.some((violation) => violation.includes('parent status sync precheck failed: blocked_status')));
        assert.equal(normalizeNewlines(fs.readFileSync(appPath, 'utf8')), 'export const value = 1;\n');
        assert.equal(runGit(repoRoot, ['diff', '--name-only']).trim(), '');
        assert.equal(runGit(repoRoot, ['diff', '--name-only', '--cached']).trim(), '');
    });

    it('blocks restore when the requested manifest is not bound by current materialization evidence', () => {
        const { repoRoot, preflightPath, fullSuitePath } = makeRepo();
        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const value = 2;\n', 'utf8');
        runGit(repoRoot, ['add', 'src/app.ts']);
        const materialized = materializeFullSuiteRepairTask({
            repoRoot,
            taskId: TASK_ID,
            preflightPath,
            fullSuiteArtifactPath: fullSuitePath
        });
        assert.equal(materialized.status, 'MATERIALIZED', materialized.output_lines.join('\n'));

        const forgedManifestPath = path.join(
            repoRoot,
            'garda-agent-orchestrator',
            'runtime',
            'wip',
            TASK_ID,
            'full-suite-repair',
            'forged',
            'manifest.json'
        );
        writeJson(forgedManifestPath, readJson(materialized.wip_manifest_path || ''));

        const restored = restoreMaterializedWip({
            repoRoot,
            fullSuitePath,
            manifestPath: forgedManifestPath
        });

        assert.equal(restored.status, 'BLOCKED');
        assert.ok(restored.violations.some((violation) => violation.includes('not the current materialized full-suite repair WIP manifest')));
    });

    it('blocks restore when the requested manifest path escapes the repo root', () => {
        const { repoRoot, fullSuitePath } = makeRepo();
        const restored = restoreMaterializedWip({
            repoRoot,
            fullSuitePath,
            manifestPath: '../outside-manifest.json'
        });

        assert.equal(restored.status, 'BLOCKED');
        assertBlockedOperatorOutputHasNoNavigatorCommand(restored.output_lines);
        assert.ok(restored.violations.some((violation) => violation.includes('ManifestPath escapes repo root')));
    });
});
