import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveBundleName } from '../../core/constants';
import {
    bindContainedDestination,
    removeBoundContainedPath,
    type ContainedDestination
} from '../../core/contained-filesystem';
import {
    DEFAULT_GIT_CLONE_TIMEOUT_MS,
    DEFAULT_GIT_TIMEOUT_MS,
    spawnStreamed,
    spawnSyncWithTimeout
} from '../../core/subprocess';
import { type CheckUpdateRunnerOptions, runCheckUpdate } from '../check-update';
import { validateGitSourceTrust } from './update-trust';
import {
    classifyGitDiagnostic,
    createLifecycleDiagnosticError
} from './update-diagnostics';
import { registerTempRoot } from '../../cli/signal-handler';
import { assertUpdateApplyAllowedInSwitchMode } from './update-off-mode';
import {
    assertGitUpdateTransport,
    createIsolatedGitEnvironment,
    isExplicitLocalGitPath,
    verifyGitUpdateSource
} from './update-git-source-verification';

export const DEFAULT_GIT_UPDATE_REPO_URL = 'https://github.com/Garda-Studio/garda-agent-orchestrator.git';

interface GitCloneHandle {
    clonePath: string;
    env: NodeJS.ProcessEnv;
    cleanup: () => void;
}

interface RunUpdateFromGitOptions {
    targetRoot: string;
    bundleRoot: string;
    initAnswersPath?: string;
    repoUrl?: string;
    branch?: string | null;
    checkOnly?: boolean;
    noPrompt?: boolean;
    dryRun?: boolean;
    skipVerify?: boolean;
    skipManifestValidation?: boolean;
    trustOverride?: boolean;
    updateRunner?: ((options: CheckUpdateRunnerOptions) => unknown) | null;
}

function rethrowAfterCleanup(error: unknown, cleanup: () => void): never {
    try {
        cleanup();
    } catch (cleanupError) {
        const originalMessage = error instanceof Error ? error.message : String(error);
        throw new AggregateError([error, cleanupError], `${originalMessage}
Git staging cleanup also failed.`, { cause: error });
    }
    throw error;
}

export function buildGitCloneArgs(repoUrl: string, branch: string | null | undefined, destinationPath: string): string[] {
    const args = isExplicitLocalGitPath(repoUrl)
        ? ['clone', '--local', '--no-hardlinks']
        : ['clone', '--depth', '1'];
    if (branch) {
        args.push('--branch', String(branch).trim(), '--single-branch');
    }
    args.push(String(repoUrl).trim(), destinationPath);
    return args;
}

function ensureGitAvailable() {
    const result = spawnSyncWithTimeout('git', ['--version'], {
        stdio: 'pipe',
        timeoutMs: DEFAULT_GIT_TIMEOUT_MS
    });
    if (result.error || result.status !== 0) {
        const detailText = result.error ? (result.error.message || String(result.error)) : '';
        throw createLifecycleDiagnosticError({
            message: 'git is required for update git workflow.',
            tool: 'git',
            code: 'GIT_NOT_AVAILABLE',
            sourceReference: 'git',
            stderr: result.stderr,
            stdout: result.stdout,
            detailText
        });
    }
}

export async function cloneGitUpdateSource(repoUrl: string, branch: string | null): Promise<GitCloneHandle> {
    ensureGitAvailable();

    const tempClonePath = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-update-git-'));
    const cloneBinding = bindContainedDestination(path.dirname(tempClonePath), tempClonePath);
    let templateRoot: string | null = null;
    let templateBinding: ContainedDestination | null = null;
    let disposeCloneCleanup: (() => void) | null = null;
    let disposeTemplateCleanup: (() => void) | null = null;
    let cloneRemoved = false;
    let templateRemoved = false;
    const cleanup = () => {
        disposeCloneCleanup?.();
        disposeTemplateCleanup?.();
        const failures: unknown[] = [];
        try {
            if (!cloneRemoved) {
                removeBoundContainedPath(cloneBinding, true);
                cloneRemoved = true;
            }
        } catch (error) {
            failures.push(error);
        }
        try {
            if (templateRoot && !templateBinding) {
                throw new Error(`Cannot authenticate isolated Git template cleanup owner: ${templateRoot}`);
            }
            if (templateBinding && !templateRemoved) {
                removeBoundContainedPath(templateBinding, true);
                templateRemoved = true;
            }
        } catch (error) {
            failures.push(error);
        }
        if (failures.length === 1) throw failures[0];
        if (failures.length > 1) throw new AggregateError(failures, 'Failed to clean up both Git update staging roots.');
    };
    let env: NodeJS.ProcessEnv;
    try {
        disposeCloneCleanup = registerTempRoot(tempClonePath, cloneBinding);
        templateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-update-template-'));
        templateBinding = bindContainedDestination(path.dirname(templateRoot), templateRoot);
        disposeTemplateCleanup = registerTempRoot(templateRoot, templateBinding);
        env = createIsolatedGitEnvironment(templateRoot);
    } catch (error) {
        rethrowAfterCleanup(error, cleanup);
    }
    const diagnosticSource = branch ? `${repoUrl}#${branch}` : repoUrl;
    const cloneResult = await spawnStreamed('git', buildGitCloneArgs(repoUrl, branch, tempClonePath), {
        timeoutMs: DEFAULT_GIT_CLONE_TIMEOUT_MS,
        env,
        envMode: 'replace',
        onStderr(chunk) { process.stderr.write(chunk); }
    }).catch((error: unknown) => {
        rethrowAfterCleanup(error, cleanup);
    });

    if (cloneResult.timedOut) {
        rethrowAfterCleanup(createLifecycleDiagnosticError({
            message: `git clone timed out after ${DEFAULT_GIT_CLONE_TIMEOUT_MS} ms for '${repoUrl}'.`,
            tool: 'git',
            code: 'GIT_TIMEOUT',
            sourceReference: diagnosticSource,
            stderr: cloneResult.stderr,
            stdout: cloneResult.stdout
        }), cleanup);
    }

    if (cloneResult.exitCode !== 0) {
        const diagnosticText = `${String(cloneResult.stderr || '')}\n${String(cloneResult.stdout || '')}`;
        rethrowAfterCleanup(createLifecycleDiagnosticError({
            message: `Failed to clone git update source '${repoUrl}'.`,
            tool: 'git',
            code: classifyGitDiagnostic(diagnosticText),
            sourceReference: diagnosticSource,
            stderr: cloneResult.stderr,
            stdout: cloneResult.stdout
        }), cleanup);
    }

    return {
        clonePath: tempClonePath,
        env,
        cleanup
    };
}

export async function runUpdateFromGit(options: RunUpdateFromGitOptions) {
    const {
        targetRoot,
        bundleRoot,
        initAnswersPath = path.join(resolveBundleName(), 'runtime', 'init-answers.json'),
        repoUrl = DEFAULT_GIT_UPDATE_REPO_URL,
        branch = null,
        checkOnly = false,
        noPrompt = true,
        dryRun = false,
        skipVerify = false,
        skipManifestValidation = false,
        trustOverride = false,
        updateRunner = null
    } = options;

    const normalizedRepoUrl = String(repoUrl || DEFAULT_GIT_UPDATE_REPO_URL).trim();
    const normalizedBranch = branch ? String(branch).trim() : null;
    const diagnosticSource = normalizedBranch ? `${normalizedRepoUrl}#${normalizedBranch}` : normalizedRepoUrl;

    assertGitUpdateTransport(normalizedRepoUrl, diagnosticSource);
    const cloneRepoUrl = isExplicitLocalGitPath(normalizedRepoUrl)
        ? path.resolve(normalizedRepoUrl)
        : normalizedRepoUrl;
    const trustResult = validateGitSourceTrust(normalizedRepoUrl, { trustOverride });
    assertUpdateApplyAllowedInSwitchMode({
        targetRoot,
        bundleRoot,
        applyRequested: !checkOnly,
        dryRun,
        commandName: 'update git'
    });

    const gitSource = await cloneGitUpdateSource(cloneRepoUrl, normalizedBranch);
    let gitCommitSha: string;
    let result: Awaited<ReturnType<typeof runCheckUpdate>>;
    try {
        gitCommitSha = verifyGitUpdateSource({
            sourceRoot: gitSource.clonePath,
            repoUrl: cloneRepoUrl,
            branch: normalizedBranch,
            sourceReference: diagnosticSource,
            env: gitSource.env,
            requireBundle: !checkOnly && !dryRun
        });

        result = await runCheckUpdate({
            targetRoot,
            bundleRoot,
            initAnswersPath,
            sourcePath: gitSource.clonePath,
            diagnosticSourceReference: diagnosticSource,
            diagnosticTool: 'git',
            apply: !checkOnly,
            noPrompt,
            dryRun,
            skipVerify,
            skipManifestValidation,
            trustOverride: false,
            prevalidatedPathTrustResult: trustResult,
            updateRunner: updateRunner
                ? (runnerOptions) => updateRunner({
                    ...runnerOptions,
                    sourceType: 'git',
                    sourceReference: diagnosticSource,
                    gitCommitSha
                })
                : null
        });

    } catch (error) {
        rethrowAfterCleanup(error, gitSource.cleanup);
    }
    gitSource.cleanup();
    return {
        ...result,
        sourceType: 'git',
        sourceReference: diagnosticSource,
        sourcePath: null,
        repoUrl: normalizedRepoUrl,
        branch: normalizedBranch,
        gitCommitSha,
        trustPolicy: trustResult.policy
    };
}
