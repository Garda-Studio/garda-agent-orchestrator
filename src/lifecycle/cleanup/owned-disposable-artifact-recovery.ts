import * as path from 'node:path';
import { removeBoundContainedPath } from '../../core/contained-filesystem';
import { fsyncDirectoryBestEffort } from '../../core/filesystem';
import { isPlainRecord } from '../../core/records';
import { withReviewArtifactReadSnapshot } from '../../gate-runtime/review/review-artifacts';
import { readOwnedDisposableRetirementIntent, withOwnedDisposableRecoveryMutation, type OwnedDisposableArtifactJournalOptions }
    from './owned-disposable-artifact-journal';
import type { OwnedDisposableRecoveryMutation } from './owned-disposable-artifact-recovery-mutation';
import { readOwnedDisposableArtifactRecoverySnapshot, type OwnedDisposableRecoverySnapshot }
    from './owned-disposable-artifact-recovery-snapshot';

const MAX_ERROR_CHARACTERS = 1000;

export interface OwnedDisposableArtifactRecoveryResult {
    schema_version: 1;
    kind: 'owned_disposable_artifact_recovery';
    status: 'CONFIRMATION_REQUIRED' | 'BLOCKED' | 'INCOMPLETE' | 'FINISHED';
    journal_path: string | null;
    journal_sha256: string | null;
    progress_directory: string | null;
    ownership_digest: string | null;
    already_finished: boolean;
    historical_removed_member_count: number | null;
    historical_removed_file_count: number | null;
    historical_removed_bytes: number | null;
    historical_reconciled_member_count: number | null;
    historical_reconciled_file_count: number | null;
    historical_reconciled_bytes: number | null;
    removed_member_count: number;
    removed_file_count: number;
    removed_bytes: number;
    reconciled_member_count: number;
    reconciled_file_count: number;
    reconciled_bytes: number;
    removed_roots: string[];
    remaining_file_count: number | null;
    remaining_bytes: number | null;
    mutation_attempted: boolean;
    counts_complete: boolean;
    errors: string[];
}

function describe(snapshot: OwnedDisposableRecoverySnapshot, result: OwnedDisposableArtifactRecoveryResult): void {
    const progress = snapshot.progress;
    result.journal_path = progress.authority.journal.binding.path;
    result.journal_sha256 = progress.authority.journal.sha256;
    result.progress_directory = progress.directory.path;
    result.ownership_digest = progress.authority.intent.ownership_digest;
    result.already_finished = progress.status === 'FINISHED';
    result.historical_removed_member_count = progress.known_removed_member_count;
    result.historical_removed_file_count = progress.known_removed_file_count;
    result.historical_removed_bytes = progress.known_removed_bytes;
    result.historical_reconciled_member_count = progress.reconciled_member_count;
    result.historical_reconciled_file_count = progress.reconciled_file_count;
    result.historical_reconciled_bytes = progress.reconciled_bytes;
}

function errorText(error: unknown): string {
    return (error instanceof Error ? error.message : String(error)).slice(0, MAX_ERROR_CHARACTERS);
}

function finished(snapshot: OwnedDisposableRecoverySnapshot, result: OwnedDisposableArtifactRecoveryResult): void {
    result.remaining_file_count = snapshot.remaining_file_count;
    result.remaining_bytes = snapshot.remaining_bytes;
    result.counts_complete = true;
    result.status = 'FINISHED';
}

function resume(mutation: OwnedDisposableRecoveryMutation, result: OwnedDisposableArtifactRecoveryResult): void {
    const initial = mutation.snapshot;
    describe(initial, result);
    try {
        if (initial.pending_absent_path !== null) {
            const member = initial.progress.order[initial.progress.retired_member_count];
            mutation.reconcilePending();
            result.reconciled_member_count = 1;
            result.reconciled_file_count = Number(!member.directory);
            result.reconciled_bytes = member.bytes;
        }
        for (;;) {
            const entry = mutation.pending();
            if (!entry) break;
            mutation.check(); result.mutation_attempted = true;
            removeBoundContainedPath(entry.binding, false, () => {
                result.removed_member_count += 1;
                if (!entry.view.directory) { result.removed_file_count += 1; result.removed_bytes += entry.view.bytes; }
                if (initial.progress.authority.intent.roots.some(root => root.path === entry.view.path)) {
                    result.removed_roots.push(path.relative(entry.binding.root, entry.binding.path).replace(/\\/gu, '/'));
                }
                fsyncDirectoryBestEffort(path.dirname(entry.binding.path)); mutation.removed();
            });
        }
        mutation.finish(); finished(mutation.inspect(), result);
    } catch (error) {
        result.status = 'INCOMPLETE'; result.counts_complete = false;
        result.errors.push(errorText(error));
        try { mutation.fail(errorText(error)); }
        catch (failure) { result.errors.push(errorText(`Error publication blocked; retain pending evidence: ${errorText(failure)}`)); }
    }
}

export function resumeOwnedDisposableArtifacts(options: OwnedDisposableArtifactJournalOptions): OwnedDisposableArtifactRecoveryResult {
    const result: OwnedDisposableArtifactRecoveryResult = {
        schema_version: 1, kind: 'owned_disposable_artifact_recovery', status: 'BLOCKED',
        journal_path: null, journal_sha256: null, progress_directory: null, ownership_digest: null, already_finished: false,
        historical_removed_member_count: null, historical_removed_file_count: null, historical_removed_bytes: null,
        historical_reconciled_member_count: null, historical_reconciled_file_count: null, historical_reconciled_bytes: null,
        removed_member_count: 0, removed_file_count: 0, removed_bytes: 0,
        reconciled_member_count: 0, reconciled_file_count: 0, reconciled_bytes: 0, removed_roots: [],
        remaining_file_count: null, remaining_bytes: null, mutation_attempted: false, counts_complete: false, errors: []
    };
    if (!options || options.confirmed !== true) { result.status = 'CONFIRMATION_REQUIRED'; return result; }
    try {
        if (!isPlainRecord(options)) throw new Error('Disposable recovery requires a plain exact native selection.');
        const { confirmed, ...selection } = options;
        const native = readOwnedDisposableRetirementIntent(selection);
        // Use the supported read context for compact audit evidence; its ordinary barrier takes a transient lock.
        // Unfinished mutation reconstructs all authority again outside this read context under native locks.
        const snapshot = withReviewArtifactReadSnapshot(path.join(native.selection.bundleRoot, 'runtime', 'reviews'),
            () => readOwnedDisposableArtifactRecoverySnapshot(selection));
        // A canonical terminal proof needs no new mutation generation, locks or progress publication.
        if (snapshot.progress.status === 'FINISHED') { describe(snapshot, result); finished(snapshot, result); return result; }
        withOwnedDisposableRecoveryMutation(options, mutation => resume(mutation, result));
    } catch (error) {
        result.status = result.mutation_attempted || result.status === 'INCOMPLETE' ? 'INCOMPLETE' : 'BLOCKED';
        result.counts_complete = false; result.errors.push(errorText(error));
    }
    return result;
}
