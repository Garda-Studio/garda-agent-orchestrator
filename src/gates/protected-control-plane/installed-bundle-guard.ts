import { getWorkflowConfigControlPlanePaths } from '../workflow-config/workflow-config-work-paths';
import * as path from 'node:path';
import { DEFAULT_BUNDLE_NAME } from '../../core/constants';
import { runGit } from '../../core/git-helpers';
import { isOrchestratorSourceCheckout } from './protected-control-plane';

export const INSTALLED_BUNDLE_GUIDANCE = 'Never edit, stage or commit Garda bundle files in an installed project, even with operator approval. Record Garda defects in the orchestrator problems log; fix them in Garda source checkout. Change live/config settings only through the workflow commands.';

export function installedBundleScopePaths(repoRoot: string, files: readonly string[]): string[] {
    if (isOrchestratorSourceCheckout(repoRoot)) return [];
    return files.filter(file => {
        const relative = path.relative(repoRoot, path.resolve(repoRoot, file)).replace(/\\/gu, '/');
        // Bundle directory discovery recognizes case variants on every platform.
        const normalized = relative.toLowerCase();
        return normalized === DEFAULT_BUNDLE_NAME || normalized.startsWith(`${DEFAULT_BUNDLE_NAME}/`);
    });
}

export function assertNoInstalledBundleScope(repoRoot: string, files: readonly string[]): void {
    // Only the bundle directory is case-insensitive on POSIX; config filenames remain exact.
    const canonical = (file: string): string => process.platform === 'win32'
        ? file.toLowerCase() : file.replace(/^[^/]+/u, bundle => bundle.toLowerCase());
    const workflowPaths = new Set(getWorkflowConfigControlPlanePaths(repoRoot)
        .filter(file => file.startsWith(`${DEFAULT_BUNDLE_NAME}/live/config/`)).map(canonical));
    const blocked = installedBundleScopePaths(repoRoot, files).filter(file => {
        const relative = path.relative(repoRoot, path.resolve(repoRoot, file)).replace(/\\/gu, '/');
        // Only existing workflow-controlled configuration retains its stricter command checks.
        return !workflowPaths.has(canonical(relative));
    });
    if (blocked.length) throw new Error(`Installed Garda bundle cannot be task scope: ${blocked.join(', ')}. ${INSTALLED_BUNDLE_GUIDANCE}`);
}

export function assertNoStagedInstalledBundle(repoRoot: string): void {
    if (isOrchestratorSourceCheckout(repoRoot)) return;
    const files = runGit(repoRoot, ['diff', '--cached', '--no-renames', '--name-only', '-z']).split('\0').filter(Boolean);
    const blocked = installedBundleScopePaths(repoRoot, files);
    if (blocked.length) throw new Error(`Installed Garda bundle cannot be committed: ${blocked.join(', ')}. ${INSTALLED_BUNDLE_GUIDANCE}`);
}

export function trackedInstalledBundleWarnings(repoRoot: string): string[] {
    if (isOrchestratorSourceCheckout(repoRoot)) return [];
    let files: string[];
    try { files = runGit(repoRoot, ['ls-files', '-z', '--', `:(top,icase)${DEFAULT_BUNDLE_NAME}`]).split('\0').filter(Boolean); }
    catch { return []; } // Git-less installations are supported.
    if (!files.length) return [];
    return [`Installed Garda bundle files are tracked by project Git (${files.length}). Preserve files on disk and untrack them with: git rm -r --cached -- ":(top,icase)${DEFAULT_BUNDLE_NAME}". The installed agent commit guard also blocks bundle removals; leave committing historical tracking cleanup to operator maintenance. ${INSTALLED_BUNDLE_GUIDANCE}`];
}


export function formatInstalledBundleMaintenanceGuidance(cliPrefix: string, taskId: string): string {
    return 'Garda self-guard is on and remains on. An operator garda update can change protected files pinned by an active task; '
        + 'an update log alone does not authorize replacing the task baseline. Preserve application changes and runtime evidence. '
        + `First inspect the installation with: ${cliPrefix} doctor --target-root ".". `
        + 'Inspect tracked bundle files with: git ls-files -- ":(top,icase)garda-agent-orchestrator". '
        + 'If any are tracked, ask the operator to untrack them while preserving disk files: git rm -r --cached -- ":(top,icase)garda-agent-orchestrator". '
        + `After operator maintenance, rerun: ${cliPrefix} next-step "${taskId}" --repo-root ".". `
        + 'Untracking alone does not refresh retained baseline hashes. If the same drift remains, stop and retain the evidence: '
        + '1.4.4 has no authenticated update-to-task rebind while self-guard stays on. '
        + 'The operator must choose recovery from the pre-update backup or a future supported rebind; do not patch bundle code, '
        + 'disable self-guard, rewrite snapshots, or reset the task automatically.';
}
