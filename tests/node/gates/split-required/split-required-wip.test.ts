import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    captureAndSuspendSplitRequiredWip,
    listSplitRequiredWip,
    restoreSplitRequiredWip,
    retireSplitRequiredWip
} from '../../../../src/gates/split-required/split-required-wip';
import {
    listSplitRequiredWip as listSplitRequiredWipOperation,
    restoreSplitRequiredWip as restoreSplitRequiredWipOperation,
    retireSplitRequiredWip as retireSplitRequiredWipOperation
} from '../../../../src/gates/split-required/split-required-wip-operations';
import {
    materializeSplitRequiredLatch,
    readSplitRequiredLatchEvidence,
    type SplitRequiredLatchFaultBoundary
} from '../../../../src/gates/next-step/next-step-split-required-latch';
import {
    resolveSplitRequiredTaskQueueRoute
} from '../../../../src/gates/next-step/next-step-terminal-status-routing';
import {
    resolveTaskQueueTransactionLockPath,
    withTaskQueueTransaction
} from '../../../../src/core/task-queue/task-queue-repository';
import {
    acquireFilesystemLock,
    releaseFilesystemLock
} from '../../../../src/gate-runtime/task-events-locking';
import { appendMandatoryTaskEvent } from '../../../../src/gate-runtime/task-events';
import {
    runCliWithCapturedOutput
} from '../../cli/commands/gate-test-cli-capture';

const TASK_ID = 'T-WIP-1';

function runGit(repoRoot: string, args: string[]): string {
    return childProcess.execFileSync('git', ['-C', repoRoot, ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe']
    });
}

function writeFile(repoRoot: string, relativePath: string, content: string | Buffer): void {
    const filePath = path.join(repoRoot, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
}

function readFile(repoRoot: string, relativePath: string): string {
    return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

function readBuffer(repoRoot: string, relativePath: string): Buffer {
    return fs.readFileSync(path.join(repoRoot, relativePath));
}

function makeRepo(): string {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-split-wip-'));
    runGit(repoRoot, ['init']);
    runGit(repoRoot, ['config', 'user.email', 'test@example.invalid']);
    runGit(repoRoot, ['config', 'user.name', 'Test User']);
    runGit(repoRoot, ['config', 'core.autocrlf', 'false']);
    runGit(repoRoot, ['config', 'core.eol', 'lf']);
    writeFile(repoRoot, '.gitignore', [
        'garda-agent-orchestrator/runtime/',
        ''
    ].join('\n'));
    writeFile(repoRoot, 'TASK.md', [
        '# TASK.md',
        '',
        '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
        '|---|---|---|---|---|---|---|---|---|',
        `| ${TASK_ID} | IN_PROGRESS | P1 | workflow | Parent | gpt-5.5 | 2026-06-30 | strict | Split parent. |`,
        ''
    ].join('\n'));
    writeFile(repoRoot, 'src/a.ts', 'export const a = 1;\n');
    writeFile(repoRoot, 'src/b.ts', 'export const b = 1;\n');
    runGit(repoRoot, ['add', '.']);
    runGit(repoRoot, ['commit', '-m', 'initial']);
    return repoRoot;
}

function writePreflight(repoRoot: string, changedFiles: string[]): string {
    const preflightPath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews', `${TASK_ID}-preflight.json`);
    fs.mkdirSync(path.dirname(preflightPath), { recursive: true });
    fs.writeFileSync(preflightPath, `${JSON.stringify({
        task_id: TASK_ID,
        changed_files: changedFiles,
        required_reviews: {},
        metrics: {
            changed_files_count: changedFiles.length,
            changed_lines_total: changedFiles.length
        }
    }, null, 2)}\n`, 'utf8');
    return preflightPath;
}

function capture(repoRoot: string, changedFiles: string[]) {
    const preflightPath = writePreflight(repoRoot, changedFiles);
    return captureAndSuspendSplitRequiredWip({
        repoRoot,
        taskId: TASK_ID,
        preflightPath,
        guardKind: 'scope_budget',
        guardReason: 'test split-required guard'
    });
}

describe('split-required WIP capture and restore', () => {
    it('keeps the compatibility facade bound to the extracted operations', () => {
        assert.equal(listSplitRequiredWip, listSplitRequiredWipOperation);
        assert.equal(restoreSplitRequiredWip, restoreSplitRequiredWipOperation);
        assert.equal(retireSplitRequiredWip, retireSplitRequiredWipOperation);
    });

    it('captures WIP when ordinary split-required latch materializes in a git worktree', () => {
        const repoRoot = makeRepo();
        writeFile(repoRoot, 'src/a.ts', 'export const a = 2;\n');
        const preflightPath = writePreflight(repoRoot, ['src/a.ts']);

        const latch = materializeSplitRequiredLatch({
            repoRoot,
            eventsRoot: path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'task-events'),
            reviewsRoot: path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews'),
            taskId: TASK_ID,
            guardKind: 'scope_budget',
            guardReason: 'scope was too large',
            rawGuardSummary: 'scope budget guard',
            preflightPath,
            guardDetails: {}
        });

        assert.equal(latch.status_sync.outcome, 'updated');
        assert.equal(latch.wip_capture?.status, 'CAPTURED');
        assert.ok(latch.wip_capture?.manifest_path);
        assert.equal(readFile(repoRoot, 'src/a.ts'), 'export const a = 1;\n');
        const splitArtifact = JSON.parse(fs.readFileSync(latch.artifact_path, 'utf8')) as Record<string, unknown>;
        const wipCapture = splitArtifact.wip_capture as Record<string, unknown>;
        assert.equal(wipCapture.status, 'CAPTURED');
        assert.ok((splitArtifact.next_actions as string[]).includes('preview_or_restore_selected_wip_in_child_task'));
        assert.ok(fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8').includes(`| ${TASK_ID} | 🟫 SPLIT_REQUIRED |`));
    });

    it('preserves legitimate IN_REVIEW provenance in an updated latch', () => {
        const repoRoot = makeRepo();
        const taskPath = path.join(repoRoot, 'TASK.md');
        fs.writeFileSync(
            taskPath,
            fs.readFileSync(taskPath, 'utf8').replace('| IN_PROGRESS |', '| IN_REVIEW |'),
            'utf8'
        );
        runGit(repoRoot, ['add', 'TASK.md']);
        runGit(repoRoot, ['commit', '-m', 'set task in review']);
        writeFile(repoRoot, 'src/a.ts', 'export const a = 2;\n');
        const preflightPath = writePreflight(repoRoot, ['src/a.ts']);
        const eventsRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'task-events');
        const reviewsRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews');

        let injected = false;
        const latch = materializeSplitRequiredLatch({
            repoRoot,
            eventsRoot,
            reviewsRoot,
            taskId: TASK_ID,
            guardKind: 'scope_budget',
            guardReason: 'scope was too large',
            rawGuardSummary: 'scope budget guard',
            preflightPath,
            guardDetails: {},
            faultInjection: (candidate) => {
                if (!injected && candidate === 'after_status_sync') {
                    injected = true;
                    throw new Error('injected after_status_sync');
                }
            }
        });
        const statusEvent = fs.readFileSync(path.join(eventsRoot, `${TASK_ID}.jsonl`), 'utf8').trim().split('\n')
            .map((line) => JSON.parse(line) as { event_type: string; details?: Record<string, unknown> })
            .find((event) => event.event_type === 'STATUS_CHANGED');

        assert.equal(injected, true);
        assert.equal(latch.status_sync.outcome, 'updated');
        assert.equal(latch.status_sync.previous_status, 'IN_REVIEW');
        assert.equal(statusEvent?.details?.previous_status, 'IN_REVIEW');
        assert.equal(statusEvent?.details?.artifact_sha256, latch.artifact_sha256);
        assert.equal(readSplitRequiredLatchEvidence({ reviewsRoot, eventsRoot, taskId: TASK_ID }).valid, true);
    });

    it('recovers one coherent suspended latch after every injected transaction boundary failure', () => {
        const boundaries: SplitRequiredLatchFaultBoundary[] = [
            'after_status_sync',
            'after_wip_capture',
            'after_latch_artifact',
            'after_latch_event',
            'after_status_event'
        ];
        const recoveredBoundaries: SplitRequiredLatchFaultBoundary[] = [];

        for (const boundary of boundaries) {
            const repoRoot = makeRepo();
            writeFile(repoRoot, 'src/a.ts', `export const a = '${boundary}';\n`);
            const preflightPath = writePreflight(repoRoot, ['src/a.ts']);
            let injected = false;

            const latch = materializeSplitRequiredLatch({
                repoRoot,
                eventsRoot: path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'task-events'),
                reviewsRoot: path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews'),
                taskId: TASK_ID,
                guardKind: 'scope_budget',
                guardReason: 'scope was too large',
                rawGuardSummary: 'scope budget guard',
                preflightPath,
                guardDetails: {},
                faultInjection: (candidate) => {
                    if (!injected && candidate === boundary) {
                        injected = true;
                        throw new Error(`injected ${boundary}`);
                    }
                }
            });

            assert.equal(injected, true, boundary);
            assert.ok(
                latch.status_sync.outcome === 'updated' || latch.status_sync.outcome === 'already_synced',
                `${boundary}: ${latch.status_sync.error_message || latch.status_sync.outcome}`
            );
            assert.ok(latch.wip_capture?.manifest_path, boundary);
            assert.equal(readFile(repoRoot, 'src/a.ts'), 'export const a = 1;\n', boundary);
            assert.ok(
                fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8')
                    .includes(`| ${TASK_ID} | 🟫 SPLIT_REQUIRED |`),
                boundary
            );

            const evidence = readSplitRequiredLatchEvidence({
                reviewsRoot: path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews'),
                eventsRoot: path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'task-events'),
                taskId: TASK_ID
            });
            assert.equal(evidence.valid, true, `${boundary}: ${evidence.reason}`);
            const artifact = JSON.parse(fs.readFileSync(latch.artifact_path, 'utf8')) as {
                status_sync?: { previous_status?: string };
            };
            assert.equal(artifact.status_sync?.previous_status, 'IN_PROGRESS', boundary);
            const events = fs.readFileSync(
                path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'task-events', `${TASK_ID}.jsonl`),
                'utf8'
            );
            assert.ok(events.includes('"event_type":"SPLIT_REQUIRED_WIP_CAPTURED"'), boundary);
            assert.ok(events.includes('"event_type":"SPLIT_REQUIRED_LATCHED"'), boundary);
            assert.ok(events.includes('"event_type":"STATUS_CHANGED"'), boundary);
            const statusEvents = events.trim().split('\n')
                .map((line) => JSON.parse(line) as { event_type: string; details?: Record<string, unknown> })
                .filter((event) => event.event_type === 'STATUS_CHANGED');
            assert.equal(statusEvents.length, 1, boundary);
            assert.equal(statusEvents.at(-1)?.details?.artifact_sha256, latch.artifact_sha256, boundary);
            recoveredBoundaries.push(boundary);
        }
        assert.deepEqual(recoveredBoundaries, boundaries);
    });

    it('restores the prior status when cleanup retains a manifest after successful capture rollback', () => {
        const repoRoot = makeRepo();
        writeFile(repoRoot, 'src/a.ts', 'export const a = 2;\n');
        runGit(repoRoot, ['add', 'src/a.ts']);
        writeFile(repoRoot, 'src/a.ts', 'export const a = 3;\n');
        const preflightPath = writePreflight(repoRoot, ['src/a.ts']);
        const childProcessModule = require('node:child_process') as typeof import('node:child_process');
        const originalExecFileSync = childProcessModule.execFileSync;
        const fsModule = require('node:fs') as typeof import('node:fs');
        const originalRmSync = fsModule.rmSync;
        let rejectedCheckouts = 0;
        let cleanupRejected = false;
        childProcessModule.execFileSync = ((
            file: string,
            args?: readonly string[],
            options?: childProcess.ExecFileSyncOptions
        ) => {
            const commandArgs = Array.isArray(args) ? args.map(String) : [];
            if (rejectedCheckouts === 0
                && file === 'git'
                && commandArgs.includes('checkout')
                && commandArgs.includes('src/a.ts')) {
                rejectedCheckouts += 1;
                throw new Error('injected split capture checkout failure');
            }
            return Reflect.apply(originalExecFileSync, childProcessModule, [file, args, options]);
        }) as typeof childProcessModule.execFileSync;
        fsModule.rmSync = ((targetPath: fs.PathLike, options?: fs.RmDirOptions) => {
            const normalizedPath = path.resolve(String(targetPath));
            if (!cleanupRejected
                && normalizedPath.includes(`${path.sep}runtime${path.sep}wip${path.sep}${TASK_ID}${path.sep}`)
                && path.basename(path.dirname(normalizedPath)) === 'split-required') {
                cleanupRejected = true;
                throw new Error('injected retained capture cleanup failure');
            }
            return Reflect.apply(originalRmSync, fsModule, [targetPath, options]);
        }) as typeof fsModule.rmSync;

        let latch: ReturnType<typeof materializeSplitRequiredLatch>;
        try {
            latch = materializeSplitRequiredLatch({
                repoRoot,
                eventsRoot: path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'task-events'),
                reviewsRoot: path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews'),
                taskId: TASK_ID,
                guardKind: 'scope_budget',
                guardReason: 'scope was too large',
                rawGuardSummary: 'scope budget guard',
                preflightPath,
                guardDetails: {}
            });
        } finally {
            childProcessModule.execFileSync = originalExecFileSync;
            fsModule.rmSync = originalRmSync;
        }

        assert.equal(rejectedCheckouts, 1);
        assert.equal(cleanupRejected, true);
        assert.equal(latch.wip_capture?.status, 'BLOCKED');
        assert.equal((latch.wip_capture as { checkout_state?: string } | null)?.checkout_state, 'restored');
        assert.ok(latch.wip_capture?.manifest_path);
        assert.ok(latch.wip_capture?.violations.some(
            (violation) => violation.includes('retained capture cleanup failure')
        ));
        assert.ok(
            fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8')
                .includes(`| ${TASK_ID} | 🟨 IN_PROGRESS |`)
        );
        assert.equal(latch.status_sync.outcome, 'write_failed');
        assert.equal(readFile(repoRoot, 'src/a.ts'), 'export const a = 3;\n');
    });

    it('keeps a failed suspended capture recoverable until a fresh retry completes the latch', () => {
        const repoRoot = makeRepo();
        writeFile(repoRoot, 'src/a.ts', 'export const a = 2;\n');
        const preflightPath = writePreflight(repoRoot, ['src/a.ts']);
        const eventsRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'task-events');
        const reviewsRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews');
        const params = {
            repoRoot,
            eventsRoot,
            reviewsRoot,
            taskId: TASK_ID,
            guardKind: 'scope_budget' as const,
            guardReason: 'scope was too large',
            rawGuardSummary: 'scope budget guard',
            preflightPath,
            guardDetails: {}
        };
        const fsModule = require('node:fs') as typeof import('node:fs');
        const childProcessModule = require('node:child_process') as typeof import('node:child_process');
        const originalMkdirSync = fsModule.mkdirSync;
        const originalExecFileSync = childProcessModule.execFileSync;
        let captureEventFailureInjected = false;
        let rollbackFailureInjected = false;
        fsModule.mkdirSync = ((directoryPath: fs.PathLike, options?: fs.MakeDirectoryOptions) => {
            const normalizedPath = path.resolve(String(directoryPath));
            if (
                !captureEventFailureInjected
                && normalizedPath === path.resolve(eventsRoot)
            ) {
                captureEventFailureInjected = true;
                throw new Error('injected captured-event append failure');
            }
            return Reflect.apply(originalMkdirSync, fsModule, [directoryPath, options]);
        }) as typeof fsModule.mkdirSync;
        childProcessModule.execFileSync = ((
            file: string,
            args?: readonly string[],
            options?: childProcess.ExecFileSyncOptions
        ) => {
            const commandArgs = Array.isArray(args) ? args.map(String) : [];
            if (
                captureEventFailureInjected
                && !rollbackFailureInjected
                && file === 'git'
                && commandArgs.includes('apply')
            ) {
                rollbackFailureInjected = true;
                throw new Error('injected tracked rollback failure');
            }
            return Reflect.apply(originalExecFileSync, childProcessModule, [file, args, options]);
        }) as typeof childProcessModule.execFileSync;

        let failed: ReturnType<typeof materializeSplitRequiredLatch>;
        try {
            failed = materializeSplitRequiredLatch(params);
        } finally {
            fsModule.mkdirSync = originalMkdirSync;
            childProcessModule.execFileSync = originalExecFileSync;
        }

        assert.equal(captureEventFailureInjected, true);
        assert.equal(rollbackFailureInjected, true);
        assert.equal(failed.status_sync.outcome, 'write_failed');
        assert.equal(failed.status_sync.previous_status, 'IN_PROGRESS');
        assert.equal(failed.wip_capture?.status, 'BLOCKED');
        assert.equal((failed.wip_capture as { checkout_state?: string } | null)?.checkout_state, 'suspended');
        assert.ok(failed.wip_capture?.manifest_path);
        assert.equal(readFile(repoRoot, 'src/a.ts'), 'export const a = 1;\n');
        const failedArtifact = JSON.parse(fs.readFileSync(failed.artifact_path, 'utf8')) as {
            materialization_phase?: string;
            status_sync?: { previous_status?: string };
            wip_capture?: { status?: string; checkout_state?: string; manifest_path?: string };
        };
        assert.equal(failedArtifact.materialization_phase, 'status_sync_failed');
        assert.equal(failedArtifact.status_sync?.previous_status, 'IN_PROGRESS');
        assert.equal(failedArtifact.wip_capture?.status, 'BLOCKED');
        assert.equal(failedArtifact.wip_capture?.checkout_state, 'suspended');
        assert.equal(failedArtifact.wip_capture?.manifest_path, failed.wip_capture?.manifest_path);
        assert.ok(
            fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8')
                .includes(`| ${TASK_ID} | 🟫 SPLIT_REQUIRED |`)
        );

        const recovered = materializeSplitRequiredLatch(params);
        const recoveredArtifact = JSON.parse(fs.readFileSync(recovered.artifact_path, 'utf8')) as {
            materialization_phase?: string;
            status_sync?: { previous_status?: string };
            wip_capture?: { status?: string; manifest_path?: string };
        };

        assert.equal(recovered.status_sync.outcome, 'updated');
        assert.equal(recovered.status_sync.previous_status, 'IN_PROGRESS');
        assert.equal(recovered.wip_capture?.status, 'ALREADY_CAPTURED');
        assert.equal(recovered.wip_capture?.manifest_path, failed.wip_capture?.manifest_path);
        assert.equal(recoveredArtifact.materialization_phase, 'complete');
        assert.equal(recoveredArtifact.status_sync?.previous_status, 'IN_PROGRESS');
        assert.equal(recoveredArtifact.wip_capture?.status, 'ALREADY_CAPTURED');
        assert.equal(recoveredArtifact.wip_capture?.manifest_path, failed.wip_capture?.manifest_path);
        assert.equal(readSplitRequiredLatchEvidence({ reviewsRoot, eventsRoot, taskId: TASK_ID }).valid, true);
    });

    it('recovers original transition provenance after a failed compensating status rollback', () => {
        const repoRoot = makeRepo();
        writeFile(repoRoot, 'src/a.ts', 'export const a = 2;\n');
        writeFile(repoRoot, 'scratch.txt', 'force capture refusal\n');
        const preflightPath = writePreflight(repoRoot, ['src/a.ts']);
        const eventsRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'task-events');
        const reviewsRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews');
        const params = {
            repoRoot,
            eventsRoot,
            reviewsRoot,
            taskId: TASK_ID,
            guardKind: 'scope_budget' as const,
            guardReason: 'scope was too large',
            rawGuardSummary: 'scope budget guard',
            preflightPath,
            guardDetails: {}
        };
        const childProcessModule = require('node:child_process') as typeof import('node:child_process');
        const originalExecFileSync = childProcessModule.execFileSync;
        let queueChangedOutsideTransaction = false;
        childProcessModule.execFileSync = ((
            file: string,
            args?: readonly string[],
            options?: childProcess.ExecFileSyncOptions
        ) => {
            const commandArgs = Array.isArray(args) ? args.map(String) : [];
            if (!queueChangedOutsideTransaction && file === 'git' && commandArgs.includes('rev-parse')) {
                fs.appendFileSync(path.join(repoRoot, 'TASK.md'), '\n', 'utf8');
                queueChangedOutsideTransaction = true;
            }
            return Reflect.apply(originalExecFileSync, childProcessModule, [file, args, options]);
        }) as typeof childProcessModule.execFileSync;

        let failed: ReturnType<typeof materializeSplitRequiredLatch>;
        try {
            failed = materializeSplitRequiredLatch(params);
        } finally {
            childProcessModule.execFileSync = originalExecFileSync;
        }

        assert.equal(queueChangedOutsideTransaction, true);
        assert.equal(failed.status_sync.outcome, 'write_failed');
        assert.equal(failed.status_sync.previous_status, 'IN_PROGRESS');
        assert.ok(failed.status_sync.error_message?.includes('TASK.md changed outside the transaction'));
        const failedArtifact = JSON.parse(fs.readFileSync(failed.artifact_path, 'utf8')) as {
            materialization_phase?: string;
        };
        assert.equal(failedArtifact.materialization_phase, 'status_sync_failed');
        assert.ok(
            fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8')
                .includes(`| ${TASK_ID} | 🟫 SPLIT_REQUIRED |`)
        );

        fs.unlinkSync(path.join(repoRoot, 'scratch.txt'));
        const recovered = materializeSplitRequiredLatch(params);
        const statusEvents = fs.readFileSync(path.join(eventsRoot, `${TASK_ID}.jsonl`), 'utf8').trim().split('\n')
            .map((line) => JSON.parse(line) as { event_type: string; details?: Record<string, unknown> })
            .filter((event) => event.event_type === 'STATUS_CHANGED');

        assert.equal(recovered.status_sync.outcome, 'updated');
        assert.equal(recovered.status_sync.previous_status, 'IN_PROGRESS');
        assert.equal(statusEvents.length, 1);
        assert.equal(statusEvents[0]?.details?.previous_status, 'IN_PROGRESS');
        assert.equal(statusEvents[0]?.details?.artifact_sha256, recovered.artifact_sha256);
        assert.equal(readSplitRequiredLatchEvidence({ reviewsRoot, eventsRoot, taskId: TASK_ID }).valid, true);
    });

    it('blocks a new queue transaction while the legacy status lock is held', () => {
        const repoRoot = makeRepo();
        const taskPath = path.join(repoRoot, 'TASK.md');
        const { handle } = acquireFilesystemLock(`${taskPath}.garda-status-sync.lock`, {
            ownerLabel: 'legacy-task-queue-writer'
        });
        let operationCalled = false;
        try {
            const result = withTaskQueueTransaction(
                taskPath,
                (message) => message,
                () => {
                    operationCalled = true;
                    return 'unexpected';
                }
            );
            assert.match(result, /Could not acquire TASK\.md status-sync lock/u);
        } finally {
            releaseFilesystemLock(handle);
        }
        assert.equal(operationCalled, false);
    });

    it('repairs a missing status event on a fresh materialization without changing transition provenance', () => {
        const repoRoot = makeRepo();
        writeFile(repoRoot, 'src/a.ts', 'export const a = 2;\n');
        const preflightPath = writePreflight(repoRoot, ['src/a.ts']);
        const eventsRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'task-events');
        const reviewsRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews');
        const params = {
            repoRoot,
            eventsRoot,
            reviewsRoot,
            taskId: TASK_ID,
            guardKind: 'scope_budget' as const,
            guardReason: 'scope was too large',
            rawGuardSummary: 'scope budget guard',
            preflightPath,
            guardDetails: {}
        };

        const initial = materializeSplitRequiredLatch(params);
        const eventPath = path.join(eventsRoot, `${TASK_ID}.jsonl`);
        const withoutStatusEvent = fs.readFileSync(eventPath, 'utf8')
            .split('\n')
            .filter((line) => !line.includes('"event_type":"STATUS_CHANGED"'))
            .join('\n');
        fs.writeFileSync(eventPath, withoutStatusEvent, 'utf8');
        const incompleteEvidence = readSplitRequiredLatchEvidence({ reviewsRoot, eventsRoot, taskId: TASK_ID });
        assert.equal(incompleteEvidence.valid, false);
        assert.match(incompleteEvidence.reason, /status transition event is missing/u);

        const recovered = materializeSplitRequiredLatch(params);
        const artifact = JSON.parse(fs.readFileSync(recovered.artifact_path, 'utf8')) as {
            status_sync?: { outcome?: string; previous_status?: string };
            wip_capture?: { manifest_path?: string };
        };
        const statusEvents = fs.readFileSync(eventPath, 'utf8').trim().split('\n')
            .map((line) => JSON.parse(line) as { event_type: string; details?: Record<string, unknown> })
            .filter((event) => event.event_type === 'STATUS_CHANGED');

        assert.equal(recovered.artifact_sha256, initial.artifact_sha256);
        assert.equal(recovered.status_sync.outcome, 'updated');
        assert.equal(recovered.status_sync.previous_status, 'IN_PROGRESS');
        assert.equal(recovered.wip_capture?.manifest_path, initial.wip_capture?.manifest_path);
        assert.equal(artifact.status_sync?.outcome, 'updated');
        assert.equal(artifact.status_sync?.previous_status, 'IN_PROGRESS');
        assert.equal(artifact.wip_capture?.manifest_path, initial.wip_capture?.manifest_path);
        assert.equal(statusEvents.length, 1);
        assert.equal(statusEvents[0]?.details?.artifact_sha256, recovered.artifact_sha256);
        assert.equal(readSplitRequiredLatchEvidence({ reviewsRoot, eventsRoot, taskId: TASK_ID }).valid, true);
    });

    it('repairs a stale status event whose previous status mismatches the latch artifact', () => {
        const repoRoot = makeRepo();
        writeFile(repoRoot, 'src/a.ts', 'export const a = 2;\n');
        const preflightPath = writePreflight(repoRoot, ['src/a.ts']);
        const eventsRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'task-events');
        const reviewsRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews');
        const params = {
            repoRoot,
            eventsRoot,
            reviewsRoot,
            taskId: TASK_ID,
            guardKind: 'scope_budget' as const,
            guardReason: 'scope was too large',
            rawGuardSummary: 'scope budget guard',
            preflightPath,
            guardDetails: {}
        };

        const initial = materializeSplitRequiredLatch(params);
        const eventPath = path.join(eventsRoot, `${TASK_ID}.jsonl`);
        const eventEntries = fs.readFileSync(eventPath, 'utf8').trim().split('\n')
            .map((line) => ({
                line,
                event: JSON.parse(line) as { event_type: string; details?: Record<string, unknown> }
            }));
        const originalStatusEvent = eventEntries.find((entry) => entry.event.event_type === 'STATUS_CHANGED');
        assert.ok(originalStatusEvent?.event.details);
        fs.writeFileSync(
            eventPath,
            `${eventEntries
                .filter((entry) => entry.event.event_type !== 'STATUS_CHANGED')
                .map((entry) => entry.line)
                .join('\n')}\n`,
            'utf8'
        );
        appendMandatoryTaskEvent(
            path.join(repoRoot, 'garda-agent-orchestrator'),
            TASK_ID,
            'STATUS_CHANGED',
            'INFO',
            'Task status changed: IN_REVIEW -> SPLIT_REQUIRED.',
            { ...originalStatusEvent.event.details, previous_status: 'IN_REVIEW' },
            { actor: 'orchestrator' }
        );
        const incompleteEvidence = readSplitRequiredLatchEvidence({ reviewsRoot, eventsRoot, taskId: TASK_ID });
        assert.equal(incompleteEvidence.valid, false);
        assert.match(incompleteEvidence.reason, /status transition event is missing/u);

        const recovered = materializeSplitRequiredLatch(params);
        const events = fs.readFileSync(eventPath, 'utf8').trim().split('\n')
            .map((line) => JSON.parse(line) as { event_type: string; details?: Record<string, unknown> });
        const statusEvents = events.filter((event) => event.event_type === 'STATUS_CHANGED');
        const repairedStatusEvents = statusEvents.filter((event) => event.details?.previous_status === 'IN_PROGRESS');
        const latchEvents = events.filter((event) => event.event_type === 'SPLIT_REQUIRED_LATCHED');

        assert.equal(recovered.artifact_sha256, initial.artifact_sha256);
        assert.equal(recovered.status_sync.outcome, 'updated');
        assert.equal(recovered.status_sync.previous_status, 'IN_PROGRESS');
        assert.equal(statusEvents.length, 2);
        assert.equal(repairedStatusEvents.length, 1);
        assert.equal(latchEvents.length, 1);
        assert.equal(readSplitRequiredLatchEvidence({ reviewsRoot, eventsRoot, taskId: TASK_ID }).valid, true);
    });

    it('rebinds stale mandatory events when preflight identity changes the latch artifact hash', () => {
        const repoRoot = makeRepo();
        writeFile(repoRoot, 'src/a.ts', 'export const a = 2;\n');
        const preflightPath = writePreflight(repoRoot, ['src/a.ts']);
        const eventsRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'task-events');
        const reviewsRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews');
        const baseParams = {
            repoRoot,
            eventsRoot,
            reviewsRoot,
            taskId: TASK_ID,
            guardKind: 'scope_budget' as const,
            guardReason: 'scope was too large',
            rawGuardSummary: 'scope budget guard',
            preflightPath,
            guardDetails: {}
        };

        const initial = materializeSplitRequiredLatch(baseParams);
        const initialArtifact = JSON.parse(fs.readFileSync(initial.artifact_path, 'utf8')) as {
            preflight_sha256?: string;
        };
        writePreflight(repoRoot, ['src/a.ts', 'src/b.ts']);
        const recovered = materializeSplitRequiredLatch(baseParams);
        const recoveredArtifact = JSON.parse(fs.readFileSync(recovered.artifact_path, 'utf8')) as {
            preflight_sha256?: string;
        };
        const events = fs.readFileSync(path.join(eventsRoot, `${TASK_ID}.jsonl`), 'utf8').trim().split('\n')
            .map((line) => JSON.parse(line) as { event_type: string; details?: Record<string, unknown> });
        const currentStatusEvents = events.filter((event) => (
            event.event_type === 'STATUS_CHANGED'
            && event.details?.artifact_sha256 === recovered.artifact_sha256
        ));
        const currentLatchEvents = events.filter((event) => (
            event.event_type === 'SPLIT_REQUIRED_LATCHED'
            && event.details?.artifact_sha256 === recovered.artifact_sha256
        ));

        assert.notEqual(recovered.artifact_sha256, initial.artifact_sha256);
        assert.notEqual(recoveredArtifact.preflight_sha256, initialArtifact.preflight_sha256);
        assert.equal(recovered.status_sync.outcome, 'updated');
        assert.equal(recovered.status_sync.previous_status, 'IN_PROGRESS');
        assert.equal(currentStatusEvents.length, 1);
        assert.equal(currentLatchEvents.length, 1);
        assert.equal(readSplitRequiredLatchEvidence({ reviewsRoot, eventsRoot, taskId: TASK_ID }).valid, true);
    });

    it('rejects a forged terminal previous status from a mutable checkpoint', () => {
        const repoRoot = makeRepo();
        writeFile(repoRoot, 'src/a.ts', 'export const a = 2;\n');
        const preflightPath = writePreflight(repoRoot, ['src/a.ts']);
        const eventsRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'task-events');
        const reviewsRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews');
        const params = {
            repoRoot,
            eventsRoot,
            reviewsRoot,
            taskId: TASK_ID,
            guardKind: 'scope_budget' as const,
            guardReason: 'scope was too large',
            rawGuardSummary: 'scope budget guard',
            preflightPath,
            guardDetails: {}
        };

        const initial = materializeSplitRequiredLatch(params);
        const artifact = JSON.parse(fs.readFileSync(initial.artifact_path, 'utf8')) as Record<string, unknown>;
        artifact.status_sync = {
            outcome: 'updated',
            previous_status: 'DONE',
            next_status: 'SPLIT_REQUIRED',
            error_message: null
        };
        fs.writeFileSync(initial.artifact_path, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
        const forgedCompleteEvidence = readSplitRequiredLatchEvidence({ reviewsRoot, eventsRoot, taskId: TASK_ID });
        assert.equal(forgedCompleteEvidence.valid, false);
        assert.match(forgedCompleteEvidence.reason, /previous_status is not an active task status/u);

        artifact.materialization_phase = 'pending_status_sync';
        artifact.status_sync = {
            outcome: 'pending',
            previous_status: 'DONE',
            next_status: 'SPLIT_REQUIRED',
            error_message: null
        };
        artifact.wip_capture = null;
        fs.writeFileSync(initial.artifact_path, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
        const eventPath = path.join(eventsRoot, `${TASK_ID}.jsonl`);
        const captureOnlyEvents = fs.readFileSync(eventPath, 'utf8').split('\n')
            .filter((line) => (
                !line.includes('"event_type":"SPLIT_REQUIRED_LATCHED"')
                && !line.includes('"event_type":"STATUS_CHANGED"')
            ))
            .join('\n');
        fs.writeFileSync(eventPath, captureOnlyEvents, 'utf8');

        const recovered = materializeSplitRequiredLatch(params);
        const recoveredArtifact = JSON.parse(fs.readFileSync(recovered.artifact_path, 'utf8')) as {
            status_sync?: { outcome?: string; previous_status?: string };
        };
        const recoveredStatusEvents = fs.readFileSync(eventPath, 'utf8').trim().split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line) as { event_type: string; details?: Record<string, unknown> })
            .filter((event) => event.event_type === 'STATUS_CHANGED');

        assert.equal(recovered.status_sync.outcome, 'already_synced');
        assert.equal(recovered.status_sync.previous_status, 'SPLIT_REQUIRED');
        assert.equal(recoveredArtifact.status_sync?.outcome, 'already_synced');
        assert.equal(recoveredArtifact.status_sync?.previous_status, 'SPLIT_REQUIRED');
        assert.ok(
            fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8')
                .includes(`| ${TASK_ID} | 🟫 SPLIT_REQUIRED |`)
        );
        assert.equal(recoveredStatusEvents.length, 0);
        assert.equal(recoveredStatusEvents.some((event) => event.details?.previous_status === 'DONE'), false);
        assert.equal(readSplitRequiredLatchEvidence({ reviewsRoot, eventsRoot, taskId: TASK_ID }).valid, true);
    });

    it('recovers transition provenance from a pre-transition intent after a fresh restart', () => {
        const repoRoot = makeRepo();
        writeFile(repoRoot, 'src/a.ts', 'export const a = 2;\n');
        const preflightPath = writePreflight(repoRoot, ['src/a.ts']);
        const eventsRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'task-events');
        const reviewsRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews');
        const params = {
            repoRoot,
            eventsRoot,
            reviewsRoot,
            taskId: TASK_ID,
            guardKind: 'scope_budget' as const,
            guardReason: 'scope was too large',
            rawGuardSummary: 'scope budget guard',
            preflightPath,
            guardDetails: {}
        };

        const initial = materializeSplitRequiredLatch(params);
        const artifact = JSON.parse(fs.readFileSync(initial.artifact_path, 'utf8')) as Record<string, unknown>;
        artifact.materialization_phase = 'pending_status_sync';
        artifact.status_sync = {
            outcome: 'pending',
            previous_status: 'IN_PROGRESS',
            next_status: 'SPLIT_REQUIRED',
            error_message: null
        };
        artifact.wip_capture = null;
        fs.writeFileSync(initial.artifact_path, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
        const eventPath = path.join(eventsRoot, `${TASK_ID}.jsonl`);
        const captureOnlyEvents = fs.readFileSync(eventPath, 'utf8').split('\n')
            .filter((line) => (
                !line.includes('"event_type":"SPLIT_REQUIRED_LATCHED"')
                && !line.includes('"event_type":"STATUS_CHANGED"')
            ))
            .join('\n');
        fs.writeFileSync(eventPath, captureOnlyEvents, 'utf8');

        const recovered = materializeSplitRequiredLatch(params);
        const recoveredArtifact = JSON.parse(fs.readFileSync(recovered.artifact_path, 'utf8')) as {
            status_sync?: { outcome?: string; previous_status?: string };
        };
        const events = fs.readFileSync(eventPath, 'utf8');

        assert.equal(recovered.status_sync.outcome, 'updated');
        assert.equal(recovered.status_sync.previous_status, 'IN_PROGRESS');
        assert.equal(recoveredArtifact.status_sync?.outcome, 'updated');
        assert.equal(recoveredArtifact.status_sync?.previous_status, 'IN_PROGRESS');
        assert.ok(events.includes('"event_type":"SPLIT_REQUIRED_LATCHED"'));
        assert.ok(events.includes('"event_type":"STATUS_CHANGED"'));
        assert.equal(readSplitRequiredLatchEvidence({ reviewsRoot, eventsRoot, taskId: TASK_ID }).valid, true);
    });

    it('does not mutate the latch artifact when the task queue lock is unavailable', () => {
        const repoRoot = makeRepo();
        const preflightPath = writePreflight(repoRoot, ['src/a.ts']);
        const reviewsRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews');
        const artifactPath = path.join(reviewsRoot, `${TASK_ID}-split-required.json`);
        const sentinel = '{"sentinel":true}\n';
        writeFile(repoRoot, path.relative(repoRoot, artifactPath), sentinel);
        const { handle } = acquireFilesystemLock(
            resolveTaskQueueTransactionLockPath(path.join(repoRoot, 'TASK.md')),
            {
                ownerLabel: 'split-required-test-lock',
                requireKnownDeadOwner: true,
                allowForeignHostStaleRecovery: false
            }
        );

        try {
            const latch = materializeSplitRequiredLatch({
                repoRoot,
                eventsRoot: path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'task-events'),
                reviewsRoot,
                taskId: TASK_ID,
                guardKind: 'scope_budget',
                guardReason: 'scope was too large',
                rawGuardSummary: 'scope budget guard',
                preflightPath,
                guardDetails: {}
            });

            assert.equal(latch.status_sync.outcome, 'write_failed');
            assert.equal(fs.readFileSync(artifactPath, 'utf8'), sentinel);
        } finally {
            releaseFilesystemLock(handle);
        }
    });

    it('propagates nested task queue operation failures without invoking the lock fallback', () => {
        const repoRoot = makeRepo();
        const taskPath = path.join(repoRoot, 'TASK.md');
        let nestedLockFailureCalls = 0;

        assert.throws(() => withTaskQueueTransaction<void>(taskPath, () => undefined, () => {
            withTaskQueueTransaction<void>(taskPath, () => {
                nestedLockFailureCalls += 1;
            }, () => {
                throw new Error('nested operation failed');
            });
        }), /nested operation failed/u);
        assert.equal(nestedLockFailureCalls, 0);
    });

    it('captures tracked and task-owned untracked files, suspends the worktree, and restores all files explicitly', () => {
        const repoRoot = makeRepo();
        writeFile(repoRoot, 'src/a.ts', 'export const a = 2;\n');
        writeFile(repoRoot, 'src/new.ts', 'export const added = true;\n');
        writeFile(repoRoot, `garda-agent-orchestrator/runtime/tmp/${TASK_ID}/notes.json`, '{"task":true}\n');
        writeFile(repoRoot, `garda-agent-orchestrator/runtime/reviews/${TASK_ID}-scratch.json`, '{"ignored":true}\n');

        const captured = capture(repoRoot, ['src/a.ts', 'src/new.ts', `garda-agent-orchestrator/runtime/reviews/${TASK_ID}-scratch.json`]);
        assert.equal(captured.status, 'CAPTURED');
        assert.ok(captured.manifest_path);
        assert.deepEqual(captured.tracked_files, ['src/a.ts']);
        assert.deepEqual(captured.untracked_files.sort(), [
            `garda-agent-orchestrator/runtime/tmp/${TASK_ID}/notes.json`,
            'src/new.ts'
        ]);
        assert.equal(readFile(repoRoot, 'src/a.ts'), 'export const a = 1;\n');
        assert.equal(fs.existsSync(path.join(repoRoot, 'src/new.ts')), false);
        assert.equal(fs.existsSync(path.join(repoRoot, `garda-agent-orchestrator/runtime/tmp/${TASK_ID}/notes.json`)), false);

        const manifest = JSON.parse(fs.readFileSync(captured.manifest_path, 'utf8')) as Record<string, unknown>;
        assert.equal(manifest.kind, 'split_required_wip');
        assert.equal((manifest.ignored_runtime_artifacts as string[]).includes(`garda-agent-orchestrator/runtime/reviews/${TASK_ID}-scratch.json`), true);
        assert.ok((manifest.restore_commands as Record<string, string>).preview_partial_template.includes('restore-split-required-wip'));

        const listed = listSplitRequiredWip({ repoRoot, taskId: TASK_ID });
        assert.equal(listed.status, 'FOUND');
        assert.equal(listed.manifests.length, 1);

        const dryRun = restoreSplitRequiredWip({
            repoRoot,
            taskId: TASK_ID,
            manifestPath: captured.manifest_path,
            dryRun: true
        });
        assert.equal(dryRun.status, 'DRY_RUN_OK');
        assert.equal(readFile(repoRoot, 'src/a.ts'), 'export const a = 1;\n');

        const restored = restoreSplitRequiredWip({
            repoRoot,
            taskId: TASK_ID,
            manifestPath: captured.manifest_path
        });
        assert.equal(restored.status, 'RESTORED', restored.violations.join('\n'));
        assert.deepEqual(restored.restored_files.sort(), [
            `garda-agent-orchestrator/runtime/tmp/${TASK_ID}/notes.json`,
            'src/a.ts',
            'src/new.ts'
        ]);
        assert.equal(readFile(repoRoot, 'src/a.ts'), 'export const a = 2;\n');
        assert.equal(readFile(repoRoot, 'src/new.ts'), 'export const added = true;\n');
    });

    it('restores only selected paths and leaves the remaining captured files suspended', () => {
        const repoRoot = makeRepo();
        writeFile(repoRoot, 'src/a.ts', 'export const a = 2;\n');
        writeFile(repoRoot, 'src/b.ts', 'export const b = 2;\n');

        const captured = capture(repoRoot, ['src/a.ts', 'src/b.ts']);
        assert.equal(captured.status, 'CAPTURED');
        assert.ok(captured.manifest_path);

        const restored = restoreSplitRequiredWip({
            repoRoot,
            taskId: TASK_ID,
            manifestPath: captured.manifest_path,
            includePaths: ['src/a.ts']
        });
        assert.equal(restored.status, 'RESTORED', restored.violations.join('\n'));
        assert.deepEqual(restored.restored_files, ['src/a.ts']);
        assert.equal(readFile(repoRoot, 'src/a.ts'), 'export const a = 2;\n');
        assert.equal(readFile(repoRoot, 'src/b.ts'), 'export const b = 1;\n');
    });

    it('restores disjoint tracked subsets sequentially and rejects drift in an earlier subset', () => {
        const repoRoot = makeRepo();
        writeFile(repoRoot, 'src/a.ts', 'export const a = 2;\n');
        runGit(repoRoot, ['add', 'src/a.ts']);
        writeFile(repoRoot, 'src/b.ts', 'export const b = 2;\n');

        const captured = capture(repoRoot, ['src/a.ts', 'src/b.ts']);
        assert.ok(captured.manifest_path);

        const first = restoreSplitRequiredWip({
            repoRoot,
            taskId: TASK_ID,
            manifestPath: captured.manifest_path,
            includePaths: ['src/a.ts']
        });
        assert.equal(first.status, 'RESTORED', first.violations.join('\n'));

        const second = restoreSplitRequiredWip({
            repoRoot,
            taskId: TASK_ID,
            manifestPath: captured.manifest_path,
            includePaths: ['src/b.ts']
        });
        assert.equal(second.status, 'RESTORED', second.violations.join('\n'));
        assert.equal(readFile(repoRoot, 'src/a.ts'), 'export const a = 2;\n');
        assert.equal(readFile(repoRoot, 'src/b.ts'), 'export const b = 2;\n');
        assert.equal(runGit(repoRoot, ['diff', '--cached', '--name-only']).trim(), 'src/a.ts');

        const driftRepoRoot = makeRepo();
        writeFile(driftRepoRoot, 'src/a.ts', 'export const a = 2;\n');
        writeFile(driftRepoRoot, 'src/b.ts', 'export const b = 2;\n');
        const driftCapture = capture(driftRepoRoot, ['src/a.ts', 'src/b.ts']);
        assert.ok(driftCapture.manifest_path);
        const driftFirst = restoreSplitRequiredWip({
            repoRoot: driftRepoRoot,
            taskId: TASK_ID,
            manifestPath: driftCapture.manifest_path,
            includePaths: ['src/a.ts']
        });
        assert.equal(driftFirst.status, 'RESTORED', driftFirst.violations.join('\n'));
        runGit(driftRepoRoot, ['add', 'src/a.ts']);

        const drifted = restoreSplitRequiredWip({
            repoRoot: driftRepoRoot,
            taskId: TASK_ID,
            manifestPath: driftCapture.manifest_path,
            includePaths: ['src/b.ts']
        });
        assert.equal(drifted.status, 'BLOCKED');
        assert.ok(drifted.violations.some((violation) => violation.includes('index differs from captured WIP')));
    });

    it('round-trips staged tracked changes and preserves index state on restore', () => {
        const repoRoot = makeRepo();
        writeFile(repoRoot, 'src/a.ts', 'export const a = 2;\n');
        runGit(repoRoot, ['add', 'src/a.ts']);

        const captured = capture(repoRoot, ['src/a.ts']);
        assert.equal(captured.status, 'CAPTURED');
        assert.ok(captured.manifest_path);
        assert.equal(readFile(repoRoot, 'src/a.ts'), 'export const a = 1;\n');
        assert.equal(runGit(repoRoot, ['diff', '--cached', '--name-only']).trim(), '');

        const restored = restoreSplitRequiredWip({
            repoRoot,
            taskId: TASK_ID,
            manifestPath: captured.manifest_path
        });
        assert.equal(restored.status, 'RESTORED', restored.violations.join('\n'));
        assert.deepEqual(restored.restored_files, ['src/a.ts']);
        assert.equal(readFile(repoRoot, 'src/a.ts'), 'export const a = 2;\n');
        assert.equal(runGit(repoRoot, ['diff', '--name-only']).trim(), '');
        assert.equal(runGit(repoRoot, ['diff', '--cached', '--name-only']).trim(), 'src/a.ts');
    });

    it('round-trips tracked binary patches byte-for-byte', () => {
        const repoRoot = makeRepo();
        const original = Buffer.from([0, 1, 2, 3, 4, 255]);
        const updated = Buffer.from([0, 1, 9, 8, 7, 6, 255, 0]);
        writeFile(repoRoot, 'assets/blob.bin', original);
        runGit(repoRoot, ['add', 'assets/blob.bin']);
        runGit(repoRoot, ['commit', '-m', 'add binary asset']);
        writeFile(repoRoot, 'assets/blob.bin', updated);

        const captured = capture(repoRoot, ['assets/blob.bin']);
        assert.equal(captured.status, 'CAPTURED');
        assert.ok(captured.manifest_path);
        assert.deepEqual(readBuffer(repoRoot, 'assets/blob.bin'), original);

        const restored = restoreSplitRequiredWip({
            repoRoot,
            taskId: TASK_ID,
            manifestPath: captured.manifest_path
        });
        assert.equal(restored.status, 'RESTORED', restored.violations.join('\n'));
        assert.deepEqual(restored.restored_files, ['assets/blob.bin']);
        assert.deepEqual(readBuffer(repoRoot, 'assets/blob.bin'), updated);
    });

    it('blocks unscoped advanced restore or overlapping child edits', () => {
        const repoRoot = makeRepo();
        writeFile(repoRoot, 'src/a.ts', 'export const a = 2;\n');
        const captured = capture(repoRoot, ['src/a.ts']);
        assert.ok(captured.manifest_path);

        writeFile(repoRoot, 'src/child.ts', 'export const child = true;\n');
        runGit(repoRoot, ['add', 'src/child.ts']);
        runGit(repoRoot, ['commit', '-m', 'child work']);
        const stale = restoreSplitRequiredWip({
            repoRoot,
            taskId: TASK_ID,
            manifestPath: captured.manifest_path
        });
        assert.equal(stale.status, 'BLOCKED');
        assert.ok(stale.violations.some((violation) => violation.includes('explicit include-path')));

        runGit(repoRoot, ['reset', '--hard', 'HEAD~1']);
        writeFile(repoRoot, 'src/a.ts', 'export const childOverlap = true;\n');
        const overlap = restoreSplitRequiredWip({
            repoRoot,
            taskId: TASK_ID,
            manifestPath: captured.manifest_path
        });
        assert.equal(overlap.status, 'BLOCKED');
        assert.ok(overlap.violations.some((violation) => violation.includes('differs from captured WIP')));
    });

    it('dry-runs and atomically restores selected WIP after descendant commits advance HEAD', () => {
        const repoRoot = makeRepo();
        writeFile(repoRoot, 'src/a.ts', [
            'export const first = 1;',
            'export const middle = 1;',
            'export const last = 1;',
            ''
        ].join('\n'));
        runGit(repoRoot, ['add', 'src/a.ts']);
        runGit(repoRoot, ['commit', '-m', 'expand fixture']);
        writeFile(repoRoot, 'src/a.ts', [
            'export const first = 2;',
            'export const middle = 1;',
            'export const last = 1;',
            ''
        ].join('\n'));
        const captured = capture(repoRoot, ['src/a.ts']);
        assert.ok(captured.manifest_path);

        writeFile(repoRoot, 'src/a.ts', [
            'export const first = 1;',
            'export const middle = 1;',
            'export const last = 2;',
            ''
        ].join('\n'));
        writeFile(repoRoot, 'src/b.ts', 'export const child = 2;\n');
        runGit(repoRoot, ['add', 'src/a.ts', 'src/b.ts']);
        runGit(repoRoot, ['commit', '-m', 'advance child scope']);

        const dryRun = restoreSplitRequiredWip({
            repoRoot,
            taskId: TASK_ID,
            manifestPath: captured.manifest_path,
            includePaths: ['src/a.ts'],
            dryRun: true
        });
        assert.equal(dryRun.status, 'DRY_RUN_OK', dryRun.violations.join('\n'));
        assert.equal(readFile(repoRoot, 'src/a.ts').includes('first = 1'), true);

        const restored = restoreSplitRequiredWip({
            repoRoot,
            taskId: TASK_ID,
            manifestPath: captured.manifest_path,
            includePaths: ['src/a.ts']
        });
        assert.equal(restored.status, 'RESTORED', restored.violations.join('\n'));
        assert.deepEqual(restored.restored_files, ['src/a.ts']);
        assert.equal(readFile(repoRoot, 'src/a.ts'), [
            'export const first = 2;',
            'export const middle = 1;',
            'export const last = 2;',
            ''
        ].join('\n'));
        assert.equal(readFile(repoRoot, 'src/b.ts'), 'export const child = 2;\n');
    });

    it('dry-runs and restores only selected untracked WIP after descendant commits advance HEAD', () => {
        const repoRoot = makeRepo();
        writeFile(repoRoot, 'src/new.ts', 'export const selected = true;\n');
        writeFile(repoRoot, 'src/other.ts', 'export const unselected = true;\n');
        const captured = capture(repoRoot, ['src/new.ts', 'src/other.ts']);
        assert.ok(captured.manifest_path);
        assert.deepEqual(captured.untracked_files.sort(), ['src/new.ts', 'src/other.ts']);
        assert.equal(fs.existsSync(path.join(repoRoot, 'src/new.ts')), false);
        assert.equal(fs.existsSync(path.join(repoRoot, 'src/other.ts')), false);

        writeFile(repoRoot, 'src/child.ts', 'export const child = true;\n');
        runGit(repoRoot, ['add', 'src/child.ts']);
        runGit(repoRoot, ['commit', '-m', 'advance child scope']);

        const dryRun = restoreSplitRequiredWip({
            repoRoot,
            taskId: TASK_ID,
            manifestPath: captured.manifest_path,
            includePaths: ['src/new.ts'],
            dryRun: true
        });
        assert.equal(dryRun.status, 'DRY_RUN_OK', dryRun.violations.join('\n'));
        assert.equal(fs.existsSync(path.join(repoRoot, 'src/new.ts')), false);
        assert.equal(fs.existsSync(path.join(repoRoot, 'src/other.ts')), false);

        const restored = restoreSplitRequiredWip({
            repoRoot,
            taskId: TASK_ID,
            manifestPath: captured.manifest_path,
            includePaths: ['src/new.ts']
        });
        assert.equal(restored.status, 'RESTORED', restored.violations.join('\n'));
        assert.deepEqual(restored.restored_files, ['src/new.ts']);
        assert.equal(readFile(repoRoot, 'src/new.ts'), 'export const selected = true;\n');
        assert.equal(fs.existsSync(path.join(repoRoot, 'src/other.ts')), false);
        assert.equal(runGit(repoRoot, ['status', '--porcelain=v1']), '?? src/new.ts\n');
    });

    it('blocks advanced restore when an untracked file obstructs a tracked selected path', () => {
        const repoRoot = makeRepo();
        writeFile(repoRoot, 'src/new.ts', 'export const captured = true;\n');
        runGit(repoRoot, ['add', 'src/new.ts']);
        const captured = capture(repoRoot, ['src/new.ts']);
        assert.ok(captured.manifest_path);
        assert.deepEqual(captured.tracked_files, ['src/new.ts']);
        assert.equal(fs.existsSync(path.join(repoRoot, 'src/new.ts')), false);

        writeFile(repoRoot, 'src/child.ts', 'export const child = true;\n');
        runGit(repoRoot, ['add', 'src/child.ts']);
        runGit(repoRoot, ['commit', '-m', 'advance child scope']);
        writeFile(repoRoot, 'src/new.ts', 'untracked obstruction\n');
        const beforeStatus = runGit(repoRoot, ['status', '--porcelain=v1']);

        const restored = restoreSplitRequiredWip({
            repoRoot,
            taskId: TASK_ID,
            manifestPath: captured.manifest_path,
            includePaths: ['src/new.ts']
        });

        assert.equal(restored.status, 'BLOCKED');
        assert.ok(restored.violations.some((violation) => violation.includes('untracked obstruction')));
        assert.equal(readFile(repoRoot, 'src/new.ts'), 'untracked obstruction\n');
        assert.equal(runGit(repoRoot, ['status', '--porcelain=v1']), beforeStatus);
    });

    it('blocks advanced restore dry-run when a dangling symlink obstructs a tracked selected path', () => {
        const repoRoot = makeRepo();
        writeFile(repoRoot, 'src/new.ts', 'export const captured = true;\n');
        runGit(repoRoot, ['add', 'src/new.ts']);
        const captured = capture(repoRoot, ['src/new.ts']);
        assert.ok(captured.manifest_path);

        writeFile(repoRoot, 'src/child.ts', 'export const child = true;\n');
        runGit(repoRoot, ['add', 'src/child.ts']);
        runGit(repoRoot, ['commit', '-m', 'advance child scope']);
        const obstructionPath = path.join(repoRoot, 'src', 'new.ts');
        fs.symlinkSync(
            path.join(repoRoot, 'missing-symlink-target'),
            obstructionPath,
            process.platform === 'win32' ? 'junction' : 'file'
        );
        assert.equal(fs.existsSync(obstructionPath), false);
        assert.equal(fs.lstatSync(obstructionPath).isSymbolicLink(), true);
        const beforeStatus = runGit(repoRoot, ['status', '--porcelain=v1']);

        const dryRun = restoreSplitRequiredWip({
            repoRoot,
            taskId: TASK_ID,
            manifestPath: captured.manifest_path,
            includePaths: ['src/new.ts'],
            dryRun: true
        });

        assert.equal(dryRun.status, 'BLOCKED');
        assert.ok(dryRun.violations.some((violation) => violation.includes('untracked obstruction')));
        assert.equal(fs.lstatSync(obstructionPath).isSymbolicLink(), true);
        assert.equal(runGit(repoRoot, ['status', '--porcelain=v1']), beforeStatus);
    });

    it('treats authorized advanced-restore paths as literals instead of apply patterns', () => {
        const repoRoot = makeRepo();
        writeFile(repoRoot, 'src/file[1].ts', 'export const selected = 1;\n');
        writeFile(repoRoot, 'src/file1.ts', 'export const unselected = 1;\n');
        runGit(repoRoot, ['add', 'src/file[1].ts', 'src/file1.ts']);
        runGit(repoRoot, ['commit', '-m', 'add adversarial path fixtures']);

        writeFile(repoRoot, 'src/file[1].ts', 'export const selected = 2;\n');
        writeFile(repoRoot, 'src/file1.ts', 'export const unselected = 2;\n');
        runGit(repoRoot, ['add', 'src/file[1].ts', 'src/file1.ts']);
        const captured = capture(repoRoot, ['src/file[1].ts', 'src/file1.ts']);
        assert.ok(captured.manifest_path);

        writeFile(repoRoot, 'src/child.ts', 'export const child = true;\n');
        runGit(repoRoot, ['add', 'src/child.ts']);
        runGit(repoRoot, ['commit', '-m', 'advance child scope']);

        const restored = restoreSplitRequiredWip({
            repoRoot,
            taskId: TASK_ID,
            manifestPath: captured.manifest_path,
            includePaths: ['src/file[1].ts']
        });
        assert.equal(restored.status, 'RESTORED', restored.violations.join('\n'));
        assert.deepEqual(restored.restored_files, ['src/file[1].ts']);
        assert.equal(readFile(repoRoot, 'src/file[1].ts'), 'export const selected = 2;\n');
        assert.equal(readFile(repoRoot, 'src/file1.ts'), 'export const unselected = 1;\n');
        assert.equal(runGit(repoRoot, ['status', '--porcelain=v1']), 'M  src/file[1].ts\n');
    });

    it('rejects advanced restore without explicit path authorization or reachable manifest blobs', () => {
        const repoRoot = makeRepo();
        writeFile(repoRoot, 'src/a.ts', 'export const a = 2;\n');
        const captured = capture(repoRoot, ['src/a.ts']);
        assert.ok(captured.manifest_path);
        writeFile(repoRoot, 'src/b.ts', 'export const child = 2;\n');
        runGit(repoRoot, ['add', 'src/b.ts']);
        runGit(repoRoot, ['commit', '-m', 'advance child scope']);

        const unscoped = restoreSplitRequiredWip({
            repoRoot,
            taskId: TASK_ID,
            manifestPath: captured.manifest_path,
            dryRun: true
        });
        assert.equal(unscoped.status, 'BLOCKED');
        assert.ok(unscoped.violations.some((violation) => violation.includes('explicit include-path')));

        const manifest = JSON.parse(fs.readFileSync(captured.manifest_path, 'utf8')) as {
            tracked_files: Array<{ head_sha256: string | null }>;
        };
        manifest.tracked_files[0].head_sha256 = '0000000000000000000000000000000000000000';
        fs.writeFileSync(captured.manifest_path, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
        const missingBlob = restoreSplitRequiredWip({
            repoRoot,
            taskId: TASK_ID,
            manifestPath: captured.manifest_path,
            includePaths: ['src/a.ts'],
            dryRun: true
        });
        assert.equal(missingBlob.status, 'BLOCKED');
        assert.ok(missingBlob.violations.some((violation) => violation.includes('manifest base blob')));
        assert.equal(readFile(repoRoot, 'src/a.ts'), 'export const a = 1;\n');
    });

    it('rejects unrelated history and dirty or symbolic-link selected targets without mutation', () => {
        const unrelatedRepo = makeRepo();
        writeFile(unrelatedRepo, 'src/a.ts', 'export const a = 2;\n');
        const unrelatedCapture = capture(unrelatedRepo, ['src/a.ts']);
        assert.ok(unrelatedCapture.manifest_path);
        const unrelatedRoot = runGit(unrelatedRepo, ['commit-tree', 'HEAD^{tree}', '-m', 'unrelated root']).trim();
        runGit(unrelatedRepo, ['update-ref', 'HEAD', unrelatedRoot]);
        const unrelated = restoreSplitRequiredWip({
            repoRoot: unrelatedRepo,
            taskId: TASK_ID,
            manifestPath: unrelatedCapture.manifest_path,
            includePaths: ['src/a.ts'],
            dryRun: true
        });
        assert.equal(unrelated.status, 'BLOCKED');
        assert.ok(unrelated.violations.some((violation) => violation.includes('not an ancestor')));

        const dirtyRepo = makeRepo();
        writeFile(dirtyRepo, 'src/a.ts', 'export const a = 2;\n');
        const dirtyCapture = capture(dirtyRepo, ['src/a.ts']);
        assert.ok(dirtyCapture.manifest_path);
        writeFile(dirtyRepo, 'src/b.ts', 'export const child = 2;\n');
        runGit(dirtyRepo, ['add', 'src/b.ts']);
        runGit(dirtyRepo, ['commit', '-m', 'advance child scope']);
        writeFile(dirtyRepo, 'src/a.ts', 'export const dirty = true;\n');
        const dirty = restoreSplitRequiredWip({
            repoRoot: dirtyRepo,
            taskId: TASK_ID,
            manifestPath: dirtyCapture.manifest_path,
            includePaths: ['src/a.ts']
        });
        assert.equal(dirty.status, 'BLOCKED');
        assert.ok(dirty.violations.some((violation) => violation.includes('selected restore target is dirty')));
        assert.equal(readFile(dirtyRepo, 'src/a.ts'), 'export const dirty = true;\n');

        const symlinkRepo = makeRepo();
        writeFile(symlinkRepo, 'src/a.ts', 'export const a = 2;\n');
        const symlinkCapture = capture(symlinkRepo, ['src/a.ts']);
        assert.ok(symlinkCapture.manifest_path);
        const linkBlob = runGit(symlinkRepo, ['hash-object', '-w', '--stdin'],).trim();
        assert.ok(linkBlob);
        runGit(symlinkRepo, ['update-index', '--add', '--cacheinfo', `120000,${linkBlob},src/a.ts`]);
        runGit(symlinkRepo, ['commit', '-m', 'replace target with symlink']);
        const symlink = restoreSplitRequiredWip({
            repoRoot: symlinkRepo,
            taskId: TASK_ID,
            manifestPath: symlinkCapture.manifest_path,
            includePaths: ['src/a.ts'],
            dryRun: true
        });
        assert.equal(symlink.status, 'BLOCKED');
        assert.ok(symlink.violations.some((violation) => violation.includes('symbolic link')));
    });

    it('leaves every selected path and the index unchanged when three-way restore conflicts', () => {
        const repoRoot = makeRepo();
        writeFile(repoRoot, 'src/a.ts', 'export const a = 2;\n');
        writeFile(repoRoot, 'src/b.ts', 'export const b = 2;\n');
        const captured = capture(repoRoot, ['src/a.ts', 'src/b.ts']);
        assert.ok(captured.manifest_path);
        writeFile(repoRoot, 'src/b.ts', 'export const conflictingChild = true;\n');
        runGit(repoRoot, ['add', 'src/b.ts']);
        runGit(repoRoot, ['commit', '-m', 'conflicting child scope']);
        const beforeTree = {
            a: readFile(repoRoot, 'src/a.ts'),
            b: readFile(repoRoot, 'src/b.ts'),
            status: runGit(repoRoot, ['status', '--porcelain=v1'])
        };

        const restored = restoreSplitRequiredWip({
            repoRoot,
            taskId: TASK_ID,
            manifestPath: captured.manifest_path,
            includePaths: ['src/a.ts', 'src/b.ts']
        });
        assert.equal(restored.status, 'BLOCKED');
        assert.ok(restored.violations.some((violation) => violation.includes('three-way')));
        assert.deepEqual({
            a: readFile(repoRoot, 'src/a.ts'),
            b: readFile(repoRoot, 'src/b.ts'),
            status: runGit(repoRoot, ['status', '--porcelain=v1'])
        }, beforeTree);
    });

    it('blocks capture when unrelated untracked files would leak into child scope', () => {
        const repoRoot = makeRepo();
        writeFile(repoRoot, 'src/a.ts', 'export const a = 2;\n');
        writeFile(repoRoot, 'scratch.txt', 'unrelated\n');

        const captured = capture(repoRoot, ['src/a.ts']);
        assert.equal(captured.status, 'BLOCKED');
        assert.ok(captured.violations.some((violation) => violation.includes('unrelated untracked files')));
        assert.equal(readFile(repoRoot, 'src/a.ts'), 'export const a = 2;\n');
    });

    it('retires a captured manifest without deleting the evidence files', () => {
        const repoRoot = makeRepo();
        writeFile(repoRoot, 'src/a.ts', 'export const a = 2;\n');
        const captured = capture(repoRoot, ['src/a.ts']);
        assert.ok(captured.manifest_path);

        const retired = retireSplitRequiredWip({
            repoRoot,
            taskId: TASK_ID,
            manifestPath: captured.manifest_path,
            reason: 'child scopes no longer need this WIP'
        });
        assert.equal(retired.status, 'RETIRED');
        const manifest = JSON.parse(fs.readFileSync(captured.manifest_path, 'utf8')) as Record<string, unknown>;
        assert.equal(manifest.status, 'retired');
        assert.equal(manifest.retired_reason, 'child scopes no longer need this WIP');
        assert.equal(fs.existsSync(path.join(path.dirname(captured.manifest_path), 'unstaged.patch')), true);
    });

    it('dispatches public split-required WIP gate commands with output and exit codes', async () => {
        const repoRoot = makeRepo();
        writeFile(repoRoot, 'src/a.ts', 'export const a = 2;\n');
        writeFile(repoRoot, 'src/new.ts', 'export const added = true;\n');
        const captured = capture(repoRoot, ['src/a.ts', 'src/new.ts']);
        assert.ok(captured.manifest_path);

        const listed = await runCliWithCapturedOutput([
            'gate',
            'list-split-required-wip',
            '--task-id',
            TASK_ID,
            '--repo-root',
            repoRoot
        ]);
        assert.equal(listed.exitCode, 0);
        assert.ok(listed.logs.includes('SPLIT_REQUIRED_WIP_FOUND'));
        assert.ok(listed.logs.includes('ManifestCount: 1'));
        assert.ok(listed.logs.some((line) => line.startsWith('ManifestPath: ')));

        const preview = await runCliWithCapturedOutput([
            'gate',
            'restore-split-required-wip',
            '--task-id',
            TASK_ID,
            '--manifest-path',
            captured.manifest_path,
            '--include-paths',
            'src/a.ts,src/new.ts',
            '--dry-run',
            '--repo-root',
            repoRoot
        ]);
        assert.equal(preview.exitCode, 0);
        assert.ok(preview.logs.includes('SPLIT_REQUIRED_WIP_RESTORE_DRY_RUN_OK'));
        assert.ok(preview.logs.includes('SelectedPaths: src/a.ts, src/new.ts'));
        assert.equal(readFile(repoRoot, 'src/a.ts'), 'export const a = 1;\n');
        assert.equal(fs.existsSync(path.join(repoRoot, 'src/new.ts')), false);

        const blocked = await runCliWithCapturedOutput([
            'gate',
            'restore-split-required-wip',
            '--task-id',
            TASK_ID,
            '--manifest-path',
            '../outside-manifest.json',
            '--repo-root',
            repoRoot
        ]);
        assert.notEqual(blocked.exitCode, 0);
        assert.ok(blocked.errors.includes('GARDA_CLI_FAILED'));
        assert.ok(blocked.errors.some((line) =>
            line.includes('--manifest-path must resolve inside workspace root without symlink or junction escapes')
            && line.includes('candidate=')
        ));

        const retired = await runCliWithCapturedOutput([
            'gate',
            'retire-split-required-wip',
            '--task-id',
            TASK_ID,
            '--manifest-path',
            captured.manifest_path,
            '--reason',
            'child task restored selected files',
            '--repo-root',
            repoRoot
        ]);
        assert.equal(retired.exitCode, 0);
        assert.ok(retired.logs.includes('SPLIT_REQUIRED_WIP_RETIRED'));
        assert.ok(retired.logs.includes('Reason: child task restored selected files'));
    });

    it('surfaces split-required WIP list and explicit restore guidance in terminal routing', () => {
        const route = resolveSplitRequiredTaskQueueRoute({
            taskId: TASK_ID,
            latchValid: true,
            latchInvalidReason: '',
            hasChildren: false,
            transitionResult: null,
            childRoute: null,
            continueChildCommand: null
        });

        assert.equal(route.status, 'SPLIT_REQUIRED');
        assert.equal(route.nextGate, 'split-required-latch');
        assert.ok(route.reason.includes('node bin/garda.js gate list-split-required-wip'));
        assert.ok(route.reason.includes(`--task-id \\\"${TASK_ID}\\\"`));
        assert.ok(route.reason.includes('--repo-root \\\".\\\"'));
        assert.ok(route.reason.includes('restore only by explicit preview/apply commands in child scope'));
    });
});
