import * as path from 'node:path';
import { DEFAULT_BUNDLE_NAME } from '../../core/constants';
import { runGit } from '../../core/git-helpers';
import { isOrchestratorSourceCheckout } from './protected-control-plane';

export const INSTALLED_BUNDLE_GUIDANCE = 'Never edit, stage or commit Garda bundle files in an installed project, even with operator approval. Record Garda defects in the orchestrator problems log; fix them in Garda source checkout. Change live/config settings only through the workflow commands.';

export function installedBundleScopePaths(repoRoot: string, files: readonly string[]): string[] {
    if (isOrchestratorSourceCheckout(repoRoot)) return [];
    return files.filter(file => {
        const relative = path.relative(repoRoot, path.resolve(repoRoot, file)).replace(/\\/gu, '/');
        const normalized = process.platform === 'win32' ? relative.toLowerCase() : relative;
        return normalized === DEFAULT_BUNDLE_NAME || normalized.startsWith(`${DEFAULT_BUNDLE_NAME}/`);
    });
}

export function assertNoInstalledBundleScope(repoRoot: string, files: readonly string[]): void {
    const blocked = installedBundleScopePaths(repoRoot, files).filter(file => {
        const relative = path.relative(repoRoot, path.resolve(repoRoot, file)).replace(/\\/gu, '/').toLowerCase();
        // Existing workflow policy and authenticated config-command checks still own configuration.
        return !relative.startsWith(`${DEFAULT_BUNDLE_NAME}/live/config/`)
            && !relative.startsWith(`${DEFAULT_BUNDLE_NAME}/runtime/`);
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
    try { files = runGit(repoRoot, ['ls-files', '-z', '--', `:(top)${DEFAULT_BUNDLE_NAME}/`]).split('\0').filter(Boolean); }
    catch { return []; } // Git-less installations are supported.
    if (!files.length) return [];
    return [`Installed Garda bundle files are tracked by project Git (${files.length}). Preserve files on disk and untrack them with: git rm -r --cached -- "${DEFAULT_BUNDLE_NAME}/". Then commit the index removal. ${INSTALLED_BUNDLE_GUIDANCE}`];
}


export function formatInstalledBundleMaintenanceGuidance(cliPrefix: string, taskId: string): string {
    return 'Garda self-guard is on and remains on. An operator garda update can change protected files pinned by an active task; '
        + 'an update log alone does not authorize replacing the task baseline. Preserve application changes and runtime evidence. '
        + `First inspect the installation with: ${cliPrefix} doctor --target-root ".". `
        + 'Inspect tracked bundle files with: git ls-files -- "garda-agent-orchestrator/". '
        + 'If any are tracked, ask the operator to untrack them while preserving disk files: git rm -r --cached -- "garda-agent-orchestrator/". '
        + `After operator maintenance, rerun: ${cliPrefix} next-step "${taskId}" --repo-root ".". `
        + 'Untracking alone does not refresh retained baseline hashes. If the same drift remains, stop and retain the evidence: '
        + '1.4.4 has no authenticated update-to-task rebind while self-guard stays on. '
        + 'The operator must choose recovery from the pre-update backup or a future supported rebind; do not patch bundle code, '
        + 'disable self-guard, rewrite snapshots, or reset the task automatically.';
}
