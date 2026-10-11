import type { ContainedDestination } from '../../core/contained-filesystem';

export const OWNED_DISPOSABLE_ARTIFACT_CATEGORIES = Object.freeze([
    'raw-stdout', 'raw-stderr', 'coverage-intermediate', 'temporary-source-tree',
    'temporary-test-tree', 'temporary-build-tree', 'diagnostic-archive'
] as const);

export type OwnedDisposableArtifactCategory = typeof OWNED_DISPOSABLE_ARTIFACT_CATEGORIES[number];

export interface OwnedDisposableArtifactOptions {
    targetRoot: string;
    bundleRoot: string;
    taskId: string;
}

export interface OwnedDisposableArtifactRegistrationOptions extends OwnedDisposableArtifactOptions {
    category: OwnedDisposableArtifactCategory;
}

export interface OwnedDisposableArtifactSelection extends OwnedDisposableArtifactOptions {
    registrationId: string;
}

export interface OwnedDisposableArtifactRegistration {
    registrationId: string;
    payloadPath: string;
    ownerPath: string;
}

export interface OwnedDisposableArtifactRecord {
    schema_version: 1;
    kind: 'owned_disposable_artifact';
    registration_id: string;
    workspace_identity: string;
    task_id: string;
    run_id: string;
    category: OwnedDisposableArtifactCategory;
    payload_relative_path: string;
    root_creation_identity: string;
    pid: number;
    hostname: string;
    producer_instance_id: string;
    registered_at_utc: string;
    sealed_at_utc: string | null;
    authentication_sha256: string;
}

export interface OwnedDisposableArtifactInspection {
    record: Readonly<OwnedDisposableArtifactRecord>;
    rootBinding: ContainedDestination;
    ownerSha256: string;
    producerState: 'live' | 'dead' | 'unknown' | 'foreign';
}
