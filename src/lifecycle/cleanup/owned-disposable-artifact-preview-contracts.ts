import type { OwnedDisposableArtifactCategory, OwnedDisposableArtifactOptions } from './owned-disposable-artifact-contracts';

export interface OwnedDisposableArtifactPreviewSelection extends OwnedDisposableArtifactOptions {
    registrationIds: readonly string[];
}

export interface OwnedDisposableArtifactFilePreview {
    path: string;
    directory: boolean;
    identity: string;
    binding_sha256: string;
    bytes: number;
    sha256: string | null;
}

export interface OwnedDisposableArtifactItemPreview {
    registration_id: string;
    category: OwnedDisposableArtifactCategory | null;
    path: string | null;
    run_id: string | null;
    owner_sha256: string | null;
    state: 'eligible' | 'protected';
    file_count: number;
    bytes: number;
    inventory: OwnedDisposableArtifactFilePreview[];
    blockers: string[];
}

export interface OwnedDisposableArtifactPreview {
    schema_version: 1;
    kind: 'owned_disposable_artifact_preview';
    policy: 'sealed-dead-local-authenticated-closeout-v1';
    status: 'READY' | 'BLOCKED';
    task_id: string;
    registration_ids: string[];
    items: OwnedDisposableArtifactItemPreview[];
    file_count: number;
    total_bytes: number;
    compact_evidence_sha256: string | null;
    ownership_digest: string | null;
    blockers: string[];
}

export const OWNED_DISPOSABLE_PREVIEW_LIMITS = Object.freeze({
    selectedRoots: 32, entries: 2048, pathDepth: 48, pathCharacters: 4096,
    fileBytes: 64 * 1024 * 1024, treeBytes: 128 * 1024 * 1024,
    metadataBytes: 4 * 1024 * 1024, authorityFiles: 512,
    authorityBytes: 64 * 1024 * 1024, authorityFileBytes: 4 * 1024 * 1024, queueRows: 2048
});
