import * as fs from 'node:fs';
import * as path from 'node:path';

import { spawnShellCommand, spawnStreamed } from '../../core/subprocess';
import { redactSecretText } from '../../core/redaction';
import { resolveExecutablePath } from '../../cli/gate-cli/gates-subprocess';

import {
    isSourceCheckoutRoot
} from '../../validators/workspace-layout/source-runtime';
import { normalizePath } from '../shared/helpers';
import {
    restoreSplitRequiredWip,
    restoreSplitRequiredWipForPreparedRuntimeHandoff
} from './split-required-wip-operations';
import type { SplitRequiredWipRestoreResult } from './split-required-wip-contracts';
import {
    prepareSplitRequiredWipRestoreHandoff,
    promotePreparedSplitRequiredWipRestoreHandoff,
    readAndVerifySplitRequiredWipRestoreHandoff,
    resolveSplitRequiredWipRestoreHandoffIdentity,
    SPLIT_REQUIRED_WIP_RESTORE_HANDOFF_ENV
} from './split-required-wip-runtime-handoff-contracts';
import {
    authenticateFinalizedSplitRequiredWipRestoreHandoff,
    assertTaskTimelineAnchorUnchanged,
    finalizeSplitRequiredWipRestoreHandoff
} from './split-required-wip-runtime-handoff';

const MAX_CHILD_OUTPUT_BYTES = 16 * 1024 * 1024;
const RUNTIME_BUILD_TIMEOUT_MS = 10 * 60 * 1_000;
const RUNTIME_FINALIZER_TIMEOUT_MS = 2 * 60 * 1_000;
const activeRuntimeRestores = new Map<string, Promise<SplitRequiredWipRestoreResult>>();

export interface SplitRequiredWipRuntimeRestoreParams {
    repoRoot: string;
    taskId: string;
    manifestPath: string;
    includePaths?: readonly string[];
    dryRun?: boolean;
}

function blocked(manifestPath: string, message: string, handoffPath?: string): SplitRequiredWipRestoreResult {
    const safeMessage = redactSecretText(message);
    return {
        status: 'BLOCKED',
        manifest_path: normalizePath(manifestPath),
        restored_files: [],
        selected_paths: [],
        violations: [safeMessage],
        output_lines: [
            'SPLIT_REQUIRED_WIP_RESTORE_BLOCKED',
            `Violation: ${safeMessage}`,
            ...(handoffPath ? [`RuntimeHandoff: ${normalizePath(handoffPath)}`] : [])
        ]
    };
}

function lastOutputLines(value: unknown): string {
    const redacted = redactSecretText(String(value || ''));
    const lines: string[] = [];
    let lineEnd = redacted.length;
    for (let index = redacted.length - 1; index >= -1 && lines.length < 20; index -= 1) {
        if (index >= 0 && redacted.charCodeAt(index) !== 10) continue;
        const line = redacted.slice(index + 1, lineEnd).trimEnd();
        if (line) lines.push(line);
        lineEnd = index;
    }
    return lines.reverse().join(' | ');
}

async function runForcedRuntimeBuild(repoRoot: string): Promise<string | null> {
    const run = process.platform === 'win32' ? spawnShellCommand : spawnStreamed;
    try {
        const executable = resolveExecutablePath(process.platform === 'win32' ? 'npm.cmd' : 'npm', repoRoot);
        const result = await run(executable, ['run', 'build'], {
            cwd: repoRoot,
            env: {
                GARDA_BUILD_SCRIPTS_FORCE_REBUILD: '1',
                GARDA_PUBLISH_RUNTIME_FORCE_REBUILD: '1'
            },
            maxBuffer: MAX_CHILD_OUTPUT_BYTES,
            timeoutMs: RUNTIME_BUILD_TIMEOUT_MS
        });
        if (result.exitCode === 0 && !result.timedOut && !result.cancelled) return null;
        return [
            result.timedOut ? 'runtime build timed out' : '',
            result.cancelled ? 'runtime build cancelled' : '',
            lastOutputLines(result.stderr), lastOutputLines(result.stdout)
        ].filter(Boolean).join(' | ') || `npm run build exited with status ${result.exitCode}`;
    } catch (error: unknown) {
        return error instanceof Error ? error.message : String(error);
    }
}

function buildFreshRuntimeArgs(params: SplitRequiredWipRuntimeRestoreParams): string[] {
    const args = [
        path.join(path.resolve(params.repoRoot), 'bin', 'garda.js'),
        'gate',
        'restore-split-required-wip',
        '--task-id',
        params.taskId,
        '--manifest-path',
        params.manifestPath
    ];
    for (const includePath of params.includePaths || []) {
        args.push('--include-path', includePath);
    }
    args.push('--repo-root', path.resolve(params.repoRoot));
    return args;
}

async function runFreshRuntimeFinalizer(
    params: SplitRequiredWipRuntimeRestoreParams,
    handoffPath: string
): Promise<{ status: number; stdout: string; stderr: string; error: Error | null }> {
    try {
        const result = await spawnStreamed(process.execPath, buildFreshRuntimeArgs(params), {
            cwd: path.resolve(params.repoRoot),
            env: {
                [SPLIT_REQUIRED_WIP_RESTORE_HANDOFF_ENV]: handoffPath
            },
            maxBuffer: MAX_CHILD_OUTPUT_BYTES,
            timeoutMs: RUNTIME_FINALIZER_TIMEOUT_MS
        });
        return {
            status: result.exitCode, stdout: result.stdout, stderr: result.stderr,
            error: result.timedOut ? new Error('fresh runtime finalizer timed out')
                : result.cancelled ? new Error('fresh runtime finalizer cancelled') : null
        };
    } catch (error: unknown) {
        return { status: -1, stdout: '', stderr: '', error: error instanceof Error ? error : new Error(String(error)) };
    }
}

function samePath(left: string, right: string): boolean {
    return runtimeRestoreKey(left) === runtimeRestoreKey(right);
}

function runtimeRestoreKey(value: string): string {
    const resolved = path.resolve(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

async function executeRuntimeRestore(
    params: SplitRequiredWipRuntimeRestoreParams,
    repoRoot: string,
    identity: ReturnType<typeof resolveSplitRequiredWipRestoreHandoffIdentity>
): Promise<SplitRequiredWipRestoreResult> {
    try {
        let handoff;
        if (!fs.existsSync(identity.handoffPath)) {
            handoff = prepareSplitRequiredWipRestoreHandoff(identity, identity.timelineAnchor);
        } else {
            handoff = readAndVerifySplitRequiredWipRestoreHandoff(identity);
        }
        if (handoff.status === 'finalized') {
            const authenticated = authenticateFinalizedSplitRequiredWipRestoreHandoff(identity);
            return {
                status: authenticated.status === 'BLOCKED' ? 'BLOCKED' : 'RESTORED',
                manifest_path: normalizePath(identity.manifestPath),
                restored_files: authenticated.status === 'BLOCKED' ? [] : identity.restoredFiles,
                selected_paths: identity.selectedPaths,
                violations: authenticated.violations,
                output_lines: authenticated.output_lines
            };
        }
        if (handoff.status === 'prepared') {
            assertTaskTimelineAnchorUnchanged(repoRoot, identity.taskId, handoff.timeline_anchor);
            const restored = restoreSplitRequiredWipForPreparedRuntimeHandoff(identity);
            if (restored.status === 'BLOCKED') {
                return restored;
            }
            assertTaskTimelineAnchorUnchanged(repoRoot, identity.taskId, handoff.timeline_anchor);
            promotePreparedSplitRequiredWipRestoreHandoff(identity);
        }
    } catch (error: unknown) {
        return blocked(
            identity.manifestPath,
            error instanceof Error ? error.message : String(error),
            identity.handoffPath
        );
    }

    const buildFailure = await runForcedRuntimeBuild(repoRoot);
    if (buildFailure) {
        return blocked(
            identity.manifestPath,
            `restored source runtime rebuild failed: ${buildFailure}`,
            identity.handoffPath
        );
    }

    const child = await runFreshRuntimeFinalizer({ ...params, repoRoot }, identity.handoffPath);
    if (child.status !== 0 || child.error) {
        const message = [
            child.error?.message || '',
            lastOutputLines(child.stderr),
            lastOutputLines(child.stdout)
        ].filter(Boolean).join(' | ') || `fresh runtime finalizer exited with status ${child.status}`;
        return blocked(
            identity.manifestPath,
            `restored source runtime finalization failed: ${message}`,
            identity.handoffPath
        );
    }

    try {
        const authenticated = authenticateFinalizedSplitRequiredWipRestoreHandoff(identity);
        if (authenticated.status === 'BLOCKED') {
            throw new Error(
                authenticated.violations[0]
                || 'fresh runtime exited successfully without authenticated finalized handoff evidence.'
            );
        }
        return {
            status: 'RESTORED',
            manifest_path: normalizePath(identity.manifestPath),
            restored_files: identity.restoredFiles,
            selected_paths: identity.selectedPaths,
            violations: [],
            output_lines: [
                'SPLIT_REQUIRED_WIP_RESTORED',
                ...authenticated.output_lines.slice(1).map(redactSecretText)
            ]
        };
    } catch (error: unknown) {
        return blocked(
            identity.manifestPath,
            error instanceof Error ? error.message : String(error),
            identity.handoffPath
        );
    }
}

function coalesceRuntimeRestore(
    params: SplitRequiredWipRuntimeRestoreParams,
    repoRoot: string,
    identity: ReturnType<typeof resolveSplitRequiredWipRestoreHandoffIdentity>
): Promise<SplitRequiredWipRestoreResult> {
    const key = runtimeRestoreKey(identity.handoffPath);
    const active = activeRuntimeRestores.get(key);
    if (active) return active;

    const execution = executeRuntimeRestore(params, repoRoot, identity);
    activeRuntimeRestores.set(key, execution);
    const release = (): void => {
        if (activeRuntimeRestores.get(key) === execution) activeRuntimeRestores.delete(key);
    };
    void execution.then(release, release);
    return execution;
}

export async function restoreSplitRequiredWipThroughRuntimeHandoff(
    params: SplitRequiredWipRuntimeRestoreParams
): Promise<SplitRequiredWipRestoreResult> {
    const repoRoot = path.resolve(params.repoRoot || '.');
    if (params.dryRun || !isSourceCheckoutRoot(repoRoot)) {
        return restoreSplitRequiredWip(params);
    }

    let identity: ReturnType<typeof resolveSplitRequiredWipRestoreHandoffIdentity>;
    try {
        identity = resolveSplitRequiredWipRestoreHandoffIdentity({ ...params, repoRoot });
    } catch (error: unknown) {
        return blocked(
            params.manifestPath,
            error instanceof Error ? error.message : String(error)
        );
    }

    const delegatedHandoffPath = String(process.env[SPLIT_REQUIRED_WIP_RESTORE_HANDOFF_ENV] || '').trim();
    if (delegatedHandoffPath) {
        if (!samePath(delegatedHandoffPath, identity.handoffPath)) {
            return blocked(
                identity.manifestPath,
                'restored-runtime handoff path does not match the manifest and selected paths.',
                identity.handoffPath
            );
        }
        const finalized = finalizeSplitRequiredWipRestoreHandoff(identity);
        return {
            status: finalized.status === 'BLOCKED' ? 'BLOCKED' : 'RESTORED',
            manifest_path: normalizePath(identity.manifestPath),
            restored_files: finalized.status === 'BLOCKED' ? [] : identity.restoredFiles,
            selected_paths: identity.selectedPaths,
            violations: finalized.violations,
            output_lines: finalized.output_lines
        };
    }

    return coalesceRuntimeRestore(params, repoRoot, identity);
}
