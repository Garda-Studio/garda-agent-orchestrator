import { getWorkflowConfigControlPlanePaths } from '../workflow-config/workflow-config-work-paths';
import * as path from 'node:path';
import { DEFAULT_BUNDLE_NAME } from '../../core/constants';
import { runGit } from '../../core/git-helpers';
import { isOrchestratorSourceCheckout } from './protected-control-plane';

// Workspace-owned documents that the agent rules require tasks to maintain on disk inside the bundle.
const INSTALLED_BUNDLE_TASK_DOCUMENT_DIRECTORY = `${DEFAULT_BUNDLE_NAME}/live/docs/project-memory`;
const INSTALLED_BUNDLE_TASK_DOCUMENT_FILE = `${DEFAULT_BUNDLE_NAME}/live/docs/changes/CHANGELOG.md`;
const BUNDLE_PATHSPEC = `:(top,icase)${DEFAULT_BUNDLE_NAME}`;

export const INSTALLED_BUNDLE_GUIDANCE = 'Never edit, stage or commit Garda\'s own bundle files in an installed project, even with operator approval. '
    + `The task-maintained documents are ${INSTALLED_BUNDLE_TASK_DOCUMENT_DIRECTORY}/ and ${INSTALLED_BUNDLE_TASK_DOCUMENT_FILE}, on disk only. `
    + 'Write files under `garda-agent-orchestrator/runtime/` only where a gate or next-step instructs (for example quality-checklist answers); never stage or commit them. '
    + 'Record Garda defects in the TASK.md orchestrator-problems section; fix them in Garda source checkout. Change live/config settings only through the workflow commands.';

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
    const documentDirectory = canonical(INSTALLED_BUNDLE_TASK_DOCUMENT_DIRECTORY);
    const documentFile = canonical(INSTALLED_BUNDLE_TASK_DOCUMENT_FILE);
    const blocked = installedBundleScopePaths(repoRoot, files).filter(file => {
        const relative = canonical(path.relative(repoRoot, path.resolve(repoRoot, file)).replace(/\\/gu, '/'));
        // Existing workflow-controlled configuration retains its stricter command checks.
        if (workflowPaths.has(relative)) return false;
        return relative !== documentFile && !relative.startsWith(`${documentDirectory}/`);
    });
    if (blocked.length) {
        throw new Error(`Installed Garda bundle cannot be task scope: ${blocked.join(', ')}. ${INSTALLED_BUNDLE_GUIDANCE} `
            + 'If project Git tracks these files and an operator garda update rewrote them, do not edit them: run doctor and ask the operator '
            + `to untrack them while preserving disk files: git rm -r --cached -- "${BUNDLE_PATHSPEC}".`);
    }
}

export function assertNoStagedInstalledBundle(repoRoot: string): void {
    if (isOrchestratorSourceCheckout(repoRoot)) return;
    // Index removals only untrack bundle files; additions, modifications and type changes stay blocked.
    const files = runGit(repoRoot, ['diff', '--cached', '--no-renames', '--diff-filter=d', '--name-only', '-z'])
        .split('\0').filter(Boolean);
    const blocked = installedBundleScopePaths(repoRoot, files);
    if (blocked.length) throw new Error(`Installed Garda bundle cannot be committed: ${blocked.join(', ')}. ${INSTALLED_BUNDLE_GUIDANCE}`);
}

export function trackedInstalledBundleWarnings(repoRoot: string): string[] {
    if (isOrchestratorSourceCheckout(repoRoot)) return [];
    let files: string[];
    try { files = runGit(repoRoot, ['ls-files', '-z', '--', BUNDLE_PATHSPEC]).split('\0').filter(Boolean); }
    catch { return []; } // Git-less installations are supported.
    if (!files.length) return [];
    return [`Installed Garda bundle files are tracked by project Git (${files.length}). Preserve files on disk and untrack them with: git rm -r --cached -- "${BUNDLE_PATHSPEC}", then commit the removal. `
        + `The installed commit guard accepts removing bundle files from the index and still rejects added or changed bundle files. ${INSTALLED_BUNDLE_GUIDANCE}`];
}


export function formatInstalledBundleMaintenanceGuidance(cliPrefix: string, taskId: string): string {
    return 'Garda self-guard is on and remains on. An operator garda update can change protected files pinned by an active task; '
        + 'an update log alone does not authorize replacing the task baseline. Preserve application changes and runtime evidence. '
        + `First inspect the installation with: ${cliPrefix} doctor --target-root ".". `
        + `Inspect tracked bundle files with: git ls-files -- "${BUNDLE_PATHSPEC}". `
        + `If any are tracked, ask the operator to untrack them while preserving disk files: git rm -r --cached -- "${BUNDLE_PATHSPEC}". `
        + `After operator maintenance, rerun: ${cliPrefix} next-step "${taskId}" --repo-root ".". `
        + 'Untracking alone does not refresh retained baseline hashes. If the same drift remains, stop and retain the evidence: '
        + 'this Garda version has no authenticated update-to-task rebind while self-guard stays on. '
        + `As an operator decision, ${cliPrefix} rollback --target-root "." restores the latest update snapshot; it may clear the drift, `
        + `but it also restores pre-update copies of TASK.md, ${DEFAULT_BUNDLE_NAME}/live (project memory, internal changelog, settings), `
        + 'entrypoints and provider bridges, provider settings, init answers, .gitignore and the commit hook, so back up later edits first (rollback keeps a safety snapshot under '
        + `${DEFAULT_BUNDLE_NAME}/runtime/update-rollbacks/), then rerun next-step. `
        + 'Do not patch bundle code, disable self-guard, rewrite snapshots, or reset the task automatically.';
}
