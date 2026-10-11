import * as path from 'node:path';
import { removeBoundContainedPath } from '../../core/contained-filesystem';
import { fsyncDirectoryBestEffort } from '../../core/filesystem';
import { withOwnedDisposableRetirementMutation, type OwnedDisposableArtifactJournalOptions,
    type OwnedDisposableRetirementMutation } from './owned-disposable-artifact-journal';

export interface OwnedDisposableArtifactRemovalResult {
    schema_version: 1;
    kind: 'owned_disposable_artifact_removal';
    status: 'CONFIRMATION_REQUIRED' | 'BLOCKED' | 'INCOMPLETE' | 'REMOVED';
    journal_path: string | null;
    journal_sha256: string | null;
    progress_directory: string | null;
    ownership_digest: string | null;
    removed_roots: string[];
    removed_file_count: number;
    removed_bytes: number;
    mutation_attempted: boolean;
    counts_complete: boolean;
    errors: string[];
}

function applyMutation(mutation: OwnedDisposableRetirementMutation, result: OwnedDisposableArtifactRemovalResult): void {
    result.journal_path = mutation.journalPath; result.journal_sha256 = mutation.journalSha256;
    result.progress_directory = mutation.progressDirectory;
    result.ownership_digest = mutation.snapshot.preview.ownership_digest;
    try {
        for (;;) {
            const entry = mutation.pending();
            if (!entry) break;
            mutation.check(); result.mutation_attempted = true;
            removeBoundContainedPath(entry.binding, false, () => {
                if (!entry.view.directory) { result.removed_file_count += 1; result.removed_bytes += entry.view.bytes; }
                if (mutation.snapshot.roots.some(root => root.owner.rootBinding.path === entry.binding.path)) {
                    result.removed_roots.push(path.relative(mutation.snapshot.selection.targetRoot, entry.binding.path).replace(/\\/gu, '/'));
                }
                fsyncDirectoryBestEffort(path.dirname(entry.binding.path)); mutation.removed();
            });
        }
        mutation.finish(); result.status = 'REMOVED';
    } catch (error) {
        result.status = 'INCOMPLETE'; result.counts_complete = !result.mutation_attempted;
        const message = error instanceof Error ? error.message : String(error);
        result.errors.push(message);
        try { mutation.fail(message); }
        catch (failure) { result.errors.push(`Compact error publication blocked; retain pending evidence: ${failure instanceof Error ? failure.message : String(failure)}`); }
    }
}

export function removeOwnedDisposableArtifacts(options: OwnedDisposableArtifactJournalOptions): OwnedDisposableArtifactRemovalResult {
    const result: OwnedDisposableArtifactRemovalResult = { schema_version: 1, kind: 'owned_disposable_artifact_removal',
        status: 'BLOCKED', journal_path: null, journal_sha256: null, progress_directory: null, ownership_digest: null,
        removed_roots: [], removed_file_count: 0, removed_bytes: 0, mutation_attempted: false, counts_complete: true, errors: [] };
    if (!options || options.confirmed !== true) { result.status = 'CONFIRMATION_REQUIRED'; return result; }
    try { withOwnedDisposableRetirementMutation(options, mutation => applyMutation(mutation, result)); }
    catch (error) {
        result.status = result.mutation_attempted ? 'INCOMPLETE' : 'BLOCKED';
        result.counts_complete = !result.mutation_attempted;
        result.errors.push(error instanceof Error ? error.message : String(error));
    }
    return result;
}
