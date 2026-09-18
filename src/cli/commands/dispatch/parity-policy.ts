import * as path from 'node:path';

type ParityPolicyMode = 'block' | 'warn' | 'skip';

export interface CommandParityPolicy {
    mode: ParityPolicyMode;
    root: string;
    reason: string;
}

const LOCAL_BUNDLE_REFRESH_COMMANDS = new Set(['setup', 'bootstrap', 'install', 'init', 'reinit']);

function readPathFlag(commandArgv: string[], flag: string): string | null {
    for (let index = 0; index < commandArgv.length; index++) {
        const arg = commandArgv[index];
        if (arg === flag) {
            return typeof commandArgv[index + 1] === 'string' ? commandArgv[index + 1] : null;
        }
        if (arg.startsWith(`${flag}=`)) {
            return arg.slice(flag.length + 1);
        }
    }
    return null;
}

function resolveTargetOrBundleParityRoot(commandArgv: string[]): string {
    const explicitBundleRoot = readPathFlag(commandArgv, '--bundle-root');
    if (explicitBundleRoot) {
        return path.dirname(path.resolve(explicitBundleRoot));
    }
    const explicitTargetRoot = readPathFlag(commandArgv, '--target-root');
    const explicitRepoRoot = readPathFlag(commandArgv, '--repo-root');
    return explicitTargetRoot ? path.resolve(explicitTargetRoot) : explicitRepoRoot ? path.resolve(explicitRepoRoot) : '.';
}

function hasFlag(commandArgv: string[], flag: string): boolean {
    return commandArgv.some((arg) => arg === flag || arg.startsWith(`${flag}=`));
}

function resolveRepoParityRoot(commandArgv: string[]): string {
    const explicitRepoRoot = readPathFlag(commandArgv, '--repo-root');
    return explicitRepoRoot ? path.resolve(explicitRepoRoot) : '.';
}

function resolveNavigatorParityRoot(commandArgv: string[]): string {
    const explicitRepoRoot = readPathFlag(commandArgv, '--repo-root') || readPathFlag(commandArgv, '--target-root');
    return explicitRepoRoot ? path.resolve(explicitRepoRoot) : '.';
}

function isUpdateGitCheckOnly(commandArgv: string[]): boolean {
    return String(commandArgv[0] || '').trim().toLowerCase() === 'git' && hasFlag(commandArgv, '--check-only');
}

function hasRemoteSourceOverride(commandArgv: string[]): boolean {
    return hasFlag(commandArgv, '--repo-url') || hasFlag(commandArgv, '--branch');
}

function isTrustedLocalBundleRefreshCommand(commandName: string, commandArgv: string[]): boolean {
    return LOCAL_BUNDLE_REFRESH_COMMANDS.has(commandName) && !hasRemoteSourceOverride(commandArgv);
}

function buildLocalBundleRefreshParityReason(commandName: string): string {
    if (commandName === 'init' || commandName === 'reinit') {
        return `${commandName} rematerializes the existing deployed bundle without synchronizing source artifacts; ` +
            'use setup after building to update a stale deployment.';
    }
    return `${commandName} refreshes the deployed bundle from the current trusted source checkout, ` +
        'so stale source parity is surfaced without blocking the documented repair path.';
}

function isRepairInspect(commandArgv: string[]): boolean {
    const firstArg = String(commandArgv[0] || '').trim().toLowerCase();
    return !firstArg || firstArg.startsWith('-') || firstArg === 'help' || firstArg === 'inspect';
}

function isGcDryRun(commandArgv: string[]): boolean {
    return !hasFlag(commandArgv, '--confirm') || hasFlag(commandArgv, '--dry-run');
}

function buildParityPolicy(mode: ParityPolicyMode, root: string, reason: string): CommandParityPolicy {
    return { mode, root, reason };
}

export function resolveCommandParityPolicy(commandName: string, commandArgv: string[]): CommandParityPolicy {
    if (commandName === 'gate') {
        return buildParityPolicy('block', resolveRepoParityRoot(commandArgv), 'gate commands mutate lifecycle evidence and must use a fresh deployed bundle.');
    }
    if (commandName === 'next-step') {
        return buildParityPolicy('block', resolveNavigatorParityRoot(commandArgv), 'next-step is the lifecycle navigator and must not route from stale source or bundle code.');
    }
    if (['setup', 'bootstrap', 'install', 'init', 'reinit', 'update', 'rollback', 'backup', 'uninstall'].includes(commandName)) {
        if (isTrustedLocalBundleRefreshCommand(commandName, commandArgv)) {
            return buildParityPolicy(
                'warn',
                resolveTargetOrBundleParityRoot(commandArgv),
                buildLocalBundleRefreshParityReason(commandName)
            );
        }
        if (commandName === 'update' && isUpdateGitCheckOnly(commandArgv)) {
            return buildParityPolicy('warn', resolveTargetOrBundleParityRoot(commandArgv), 'update git --check-only is read-only, so stale source parity is surfaced without blocking.');
        }
        if (commandName === 'backup' && hasFlag(commandArgv, '--dry-run')) {
            return buildParityPolicy('warn', resolveTargetOrBundleParityRoot(commandArgv), 'backup create --dry-run is read-only, so stale source parity is surfaced without blocking.');
        }
        return buildParityPolicy('block', resolveTargetOrBundleParityRoot(commandArgv), 'mutating lifecycle commands must not run against a stale source checkout or deployed bundle.');
    }
    if (commandName === 'check-update') {
        const mode: ParityPolicyMode = hasFlag(commandArgv, '--apply') ? 'block' : 'warn';
        const reason = mode === 'block'
            ? 'check-update --apply mutates the workspace and must not run with stale source parity.'
            : 'check-update is read-only without --apply, so stale source parity is surfaced without blocking.';
        return buildParityPolicy(mode, resolveTargetOrBundleParityRoot(commandArgv), reason);
    }
    if (commandName === 'cleanup') {
        const mode: ParityPolicyMode = hasFlag(commandArgv, '--dry-run') ? 'warn' : 'block';
        const reason = mode === 'block'
            ? 'cleanup removes runtime artifacts unless --dry-run is passed and must not run with stale source parity.'
            : 'cleanup --dry-run is read-only, so stale source parity is surfaced without blocking.';
        return buildParityPolicy(mode, resolveTargetOrBundleParityRoot(commandArgv), reason);
    }
    if (commandName === 'gc' || commandName === 'clean') {
        const mode: ParityPolicyMode = isGcDryRun(commandArgv) ? 'warn' : 'block';
        const reason = mode === 'block'
            ? `${commandName} --confirm removes runtime artifacts and must not run with stale source parity.`
            : `${commandName} is dry-run by default, so stale source parity is surfaced without blocking.`;
        return buildParityPolicy(mode, resolveTargetOrBundleParityRoot(commandArgv), reason);
    }
    if (commandName === 'repair') {
        if (isRepairInspect(commandArgv)) {
            return buildParityPolicy('warn', resolveTargetOrBundleParityRoot(commandArgv), 'repair inspect is read-only, so stale source parity is surfaced without blocking.');
        }
        if (!hasFlag(commandArgv, '--confirm')) {
            return buildParityPolicy('warn', resolveTargetOrBundleParityRoot(commandArgv), 'repair mutation subcommands are dry-run by default, so stale source parity is surfaced without blocking unless --confirm is passed.');
        }
        return buildParityPolicy('block', resolveTargetOrBundleParityRoot(commandArgv), 'confirmed repair mutation paths must not run with stale source parity.');
    }
    if (['agent-init', 'skills', 'review-capabilities', 'review-catalog', 'templates', 'profile', 'workflow', 'html', 'ui', 'on', 'off'].includes(commandName)) {
        return buildParityPolicy('block', resolveTargetOrBundleParityRoot(commandArgv), 'workspace configuration and workspace-selection commands require source/bundle parity before execution.');
    }
    if (['status', 'doctor', 'debug', 'stats', 'task', 'preprompt', 'verify', 'diff-managed'].includes(commandName)) {
        return buildParityPolicy('warn', resolveTargetOrBundleParityRoot(commandArgv), 'read-only workspace inspection commands surface stale source parity without blocking.');
    }
    return buildParityPolicy('skip', '.', 'command has no workspace source/bundle parity policy.');
}
