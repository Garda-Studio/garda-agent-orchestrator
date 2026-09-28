import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';

import { fileSha256, stringSha256 } from '../../../../src/gate-runtime/hash';
import {
    isReviewArtifactReadBarrierParticipant,
    readReviewArtifactFileSnapshot,
    withReviewArtifactReadBarrier,
    withReviewArtifactReadSnapshot,
    writeReviewArtifactText
} from '../../../../src/gate-runtime/review-artifacts';
import { buildEventIntegrityHash } from '../../../../src/gate-runtime/task-events';
import {
    SEMANTIC_CYCLE_BASE_BINDING_KEYS,
    type SemanticCycleBaseBindingKey,
    type SemanticCycleRuntimeIdentity,
    type SemanticCycleSnapshot
} from '../../../../src/gates/semantic-cycle-resume/semantic-cycle-contract-types';
import { compareSemanticCycleSnapshots } from '../../../../src/gates/semantic-cycle-resume/semantic-cycle-comparison';
import { buildSemanticCycleSnapshot } from '../../../../src/gates/semantic-cycle-resume/semantic-cycle-snapshot';
import {
    computeSemanticCycleRebindManifestSha256,
    executeSemanticCycleRebindTransaction,
    readSemanticCycleRebindManifest,
    validateSemanticCycleRebindManifest
} from '../../../../src/gates/semantic-cycle-resume/semantic-cycle-transaction';
import {
    SEMANTIC_CYCLE_REBIND_ARTIFACT_CLASSES,
    type SemanticCycleRebindArtifactClass,
    type SemanticCycleRebindArtifactInput,
    type SemanticCycleRebindTransactionOptions
} from '../../../../src/gates/semantic-cycle-resume/semantic-cycle-transaction-types';

const runtime: SemanticCycleRuntimeIdentity = {
    cli_version: '1.3.0',
    task_event_schema_version: 2,
    snapshot_schema_version: 1
};
const fixedNow = '2026-08-14T12:00:00.000Z';

function hash(value: string): string {
    return stringSha256(value) || '';
}

interface Fixture {
    repoRoot: string;
    snapshot: SemanticCycleSnapshot;
    artifacts: SemanticCycleRebindArtifactInput[];
    options: SemanticCycleRebindTransactionOptions;
    artifactPaths: Record<SemanticCycleRebindArtifactClass, string>;
    reviewArtifactPaths: Record<string, Record<ReviewArtifactClass, string>>;
    taskEventsPath: string;
    lifecycleHashes: [string, string];
    outputPath: string;
    cleanup: () => void;
}

type ReviewArtifactClass = Exclude<SemanticCycleRebindArtifactClass, 'compile' | 'full_suite'>;

function appendIntegrityEvent(
    taskEventsPath: string,
    taskSequence: number,
    previousSha256: string | null
): string {
    const event: Record<string, unknown> = {
        timestamp_utc: fixedNow,
        task_id: 'T-1015-2',
        event_type: 'test',
        outcome: 'PASS',
        actor: 'test',
        message: `Lifecycle event ${taskSequence}`,
        details: null,
        integrity: {
            schema_version: 1,
            task_sequence: taskSequence,
            prev_event_sha256: previousSha256
        }
    };
    const eventSha256 = buildEventIntegrityHash(event) || '';
    (event.integrity as Record<string, unknown>).event_sha256 = eventSha256;
    fs.appendFileSync(taskEventsPath, `${JSON.stringify(event)}\n`, 'utf8');
    return eventSha256;
}

function createFixture(reviewTypes: readonly string[] = ['code']): Fixture {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-semantic-rebind-'));
    const evidenceRoot = path.join(repoRoot, 'runtime', 'evidence');
    fs.mkdirSync(evidenceRoot, { recursive: true });
    const taskEventsPath = path.join(repoRoot, 'runtime', 'task-events', 'T-1015-2.jsonl');
    fs.mkdirSync(path.dirname(taskEventsPath), { recursive: true });
    const sourceLifecycleSha256 = appendIntegrityEvent(taskEventsPath, 1, null);
    const targetLifecycleSha256 = appendIntegrityEvent(taskEventsPath, 2, sourceLifecycleSha256);

    const writeEvidence = (name: string, content: string): { path: string; sha256: string } => {
        const artifactPath = path.join(evidenceRoot, name);
        fs.writeFileSync(artifactPath, `${content}\n`, 'utf8');
        return { path: artifactPath, sha256: fileSha256(artifactPath) || '' };
    };
    const compile = writeEvidence('compile.json', '{"status":"PASSED"}');
    const fullSuite = writeEvidence('full-suite.json', '{"status":"PASSED"}');
    const reviewEvidence = Object.fromEntries(reviewTypes.map((reviewType) => [reviewType, {
        review_context: writeEvidence(`${reviewType}-context.json`, `{"review_type":"${reviewType}"}`),
        findings_disposition: writeEvidence(`${reviewType}-findings.json`, '{"findings":[]}'),
        review_receipt: writeEvidence(`${reviewType}-receipt.json`, '{"accepted":true}'),
        reviewer_dependency: writeEvidence(`${reviewType}-dependency.json`, '{"dependencies":[]}')
    }])) as Record<string, Record<ReviewArtifactClass, { path: string; sha256: string }>>;

    const baseBindings = Object.fromEntries(SEMANTIC_CYCLE_BASE_BINDING_KEYS.map((key) => [
        key,
        key === 'compile_evidence'
            ? compile.sha256
            : key === 'full_suite_evidence'
                ? fullSuite.sha256
                : hash(`binding:${key}`)
    ])) as Record<SemanticCycleBaseBindingKey, string>;
    const snapshot = buildSemanticCycleSnapshot({
        task_id: 'T-1015-2',
        runtime,
        lifecycle_position: {
            cycle_sha256: sourceLifecycleSha256,
            task_event_sequence: 1
        },
        bindings: baseBindings,
        review_lanes: reviewTypes.map((reviewType) => ({
            review_type: reviewType,
            context_sha256: reviewEvidence[reviewType].review_context.sha256,
            findings_disposition_sha256: reviewEvidence[reviewType].findings_disposition.sha256,
            receipt_sha256: reviewEvidence[reviewType].review_receipt.sha256,
            dependency_state_sha256: reviewEvidence[reviewType].reviewer_dependency.sha256,
            accepted_receipt: true
        }))
    });
    const comparison = compareSemanticCycleSnapshots(snapshot, structuredClone(snapshot), runtime);
    const artifacts: SemanticCycleRebindArtifactInput[] = [
        {
            artifact_class: 'compile',
            review_type: null,
            source_path: path.relative(repoRoot, compile.path),
            source_sha256: compile.sha256,
            accepted: true
        },
        {
            artifact_class: 'full_suite',
            review_type: null,
            source_path: path.relative(repoRoot, fullSuite.path),
            source_sha256: fullSuite.sha256,
            accepted: true
        },
        ...reviewTypes.flatMap((reviewType) => (
            (['review_context', 'findings_disposition', 'review_receipt', 'reviewer_dependency'] as const)
                .map((artifactClass) => ({
                    artifact_class: artifactClass,
                    review_type: reviewType,
                    source_path: path.relative(repoRoot, reviewEvidence[reviewType][artifactClass].path),
                    source_sha256: reviewEvidence[reviewType][artifactClass].sha256,
                    accepted: true
                }))
        ))
    ];
    const outputPath = path.join(
        repoRoot,
        'runtime',
        'reviews',
        'T-1015-2-semantic-cycle-rebind.json'
    );
    const options: SemanticCycleRebindTransactionOptions = {
        repo_root: repoRoot,
        output_path: outputPath,
        task_events_path: taskEventsPath,
        comparison,
        authoritative_snapshot: snapshot,
        candidate_snapshot: structuredClone(snapshot),
        current_runtime: runtime,
        source_position: {
            cycle_sha256: sourceLifecycleSha256,
            task_event_sequence: 1
        },
        target_position: {
            cycle_sha256: targetLifecycleSha256,
            task_event_sequence: 2
        },
        artifacts,
        _testHooks: { now_utc: () => fixedNow }
    };
    const primaryReviewType = reviewTypes[0];
    return {
        repoRoot,
        snapshot,
        artifacts,
        options,
        artifactPaths: {
            compile: compile.path,
            full_suite: fullSuite.path,
            review_context: reviewEvidence[primaryReviewType].review_context.path,
            findings_disposition: reviewEvidence[primaryReviewType].findings_disposition.path,
            review_receipt: reviewEvidence[primaryReviewType].review_receipt.path,
            reviewer_dependency: reviewEvidence[primaryReviewType].reviewer_dependency.path
        },
        reviewArtifactPaths: Object.fromEntries(Object.entries(reviewEvidence).map(([reviewType, evidence]) => [
            reviewType,
            Object.fromEntries(Object.entries(evidence).map(([artifactClass, artifact]) => [
                artifactClass,
                artifact.path
            ]))
        ])) as Record<string, Record<ReviewArtifactClass, string>>,
        taskEventsPath,
        lifecycleHashes: [sourceLifecycleSha256, targetLifecycleSha256],
        outputPath,
        cleanup: () => fs.rmSync(repoRoot, { recursive: true, force: true })
    };
}

describe('semantic cycle rebind transaction', () => {
    it('commits every accepted artifact class as one authenticated immutable audit record', () => {
        const fixture = createFixture();
        try {
            const result = executeSemanticCycleRebindTransaction(fixture.options);
            assert.equal(result.status, 'COMMITTED');
            assert.equal(result.mutation_allowed, true);
            assert.equal(result.route, 'semantic_rebind');
            assert.equal(result.manifest?.status, 'COMMITTED');
            assert.equal(result.manifest?.artifacts.length, 6);
            assert.deepEqual(
                new Set(result.manifest?.artifacts.map((artifact) => artifact.artifact_class)),
                new Set(SEMANTIC_CYCLE_REBIND_ARTIFACT_CLASSES)
            );
            assert.ok(result.manifest?.artifacts.every((artifact) => (
                artifact.rebound_cycle_sha256 === fixture.options.target_position.cycle_sha256
                && artifact.rebound_task_event_sequence === 2
                && artifact.accepted
            )));
            assert.equal(result.audit.event, 'SEMANTIC_CYCLE_REBIND_COMMITTED');
            assert.equal(result.audit.verified_artifact_count, 6);
            assert.deepEqual(result.audit.invalidation_codes, []);

            const persisted = readSemanticCycleRebindManifest(fixture.repoRoot, fixture.outputPath);
            assert.equal(persisted.status, 'VALID');
            assert.equal(persisted.manifest?.transaction_sha256, result.manifest?.transaction_sha256);
            const committedEvent = fs.readFileSync(fixture.taskEventsPath, 'utf8')
                .split('\n')
                .filter((line) => line.trim())
                .map((line) => JSON.parse(line) as Record<string, unknown>)
                .find((event) => event.event_type === 'SEMANTIC_CYCLE_REBIND_COMMITTED');
            const committedDetails = committedEvent?.details as Record<string, unknown> | undefined;
            assert.equal(committedDetails?.transaction_id, result.manifest?.transaction_id);
            assert.equal(committedDetails?.transaction_sha256, result.manifest?.transaction_sha256);
            assert.equal(committedDetails?.manifest_sha256, fileSha256(fixture.outputPath));
            for (const artifact of fixture.artifacts) {
                assert.equal(fileSha256(path.resolve(fixture.repoRoot, artifact.source_path)), artifact.source_sha256);
            }
        } finally {
            fixture.cleanup();
        }
    });

    it('reads a committed manifest inside the review barrier without lock-file generation drift', () => {
        const fixture = createFixture();
        try {
            const result = executeSemanticCycleRebindTransaction(fixture.options);
            assert.equal(result.status, 'COMMITTED');

            const persisted = withReviewArtifactReadBarrier(
                path.dirname(fixture.outputPath),
                () => readSemanticCycleRebindManifest(fixture.repoRoot, fixture.outputPath)
            );

            assert.equal(persisted.status, 'VALID');
            assert.equal(persisted.manifest?.transaction_sha256, result.manifest?.transaction_sha256);
        } finally {
            fixture.cleanup();
        }
    });

    it('shares barrier authority and fail-closed cache across alias and canonical review paths', (context) => {
        const fixture = createFixture();
        const physicalReviewsDir = path.dirname(fixture.outputPath);
        const aliasReviewsDir = path.join(fixture.repoRoot, 'runtime', 'reviews-alias');
        const aliasOutputPath = path.join(aliasReviewsDir, path.basename(fixture.outputPath));
        const aliasPendingPath = `${aliasOutputPath}.pending`;
        try {
            const result = executeSemanticCycleRebindTransaction(fixture.options);
            assert.equal(result.status, 'COMMITTED');
            try {
                fs.symlinkSync(
                    physicalReviewsDir,
                    aliasReviewsDir,
                    process.platform === 'win32' ? 'junction' : 'dir'
                );
            } catch {
                context.skip('Directory symlink or junction creation is unavailable in this environment.');
                return;
            }

            const physicalFromAliasBarrier = withReviewArtifactReadBarrier(
                aliasReviewsDir,
                () => readSemanticCycleRebindManifest(fixture.repoRoot, fixture.outputPath)
            );
            assert.equal(physicalFromAliasBarrier.status, 'VALID');

            const aliasFromPhysicalBarrier = withReviewArtifactReadBarrier(
                physicalReviewsDir,
                () => readSemanticCycleRebindManifest(fixture.repoRoot, aliasOutputPath)
            );
            assert.equal(aliasFromPhysicalBarrier.status, 'VALID');

            const sharedCache = withReviewArtifactReadBarrier(aliasReviewsDir, () => {
                const first = readSemanticCycleRebindManifest(fixture.repoRoot, fixture.outputPath);
                writeReviewArtifactText(aliasPendingPath, 'transaction pending\n', {
                    lowNoiseRuntimeWrites: true
                });
                const second = readSemanticCycleRebindManifest(fixture.repoRoot, aliasOutputPath);
                return { first, second };
            });
            assert.equal(sharedCache.first.status, 'VALID');
            assert.equal(sharedCache.second.status, 'INVALID');
            assert.match(sharedCache.second.violations.join(' '), /incomplete transaction marker/u);
        } finally {
            fixture.cleanup();
        }
    });

    it('binds a first-read alias route and fails closed after a temporary retarget', (context) => {
        const fixture = createFixture();
        const physicalReviewsDir = path.dirname(fixture.outputPath);
        const alternateReviewsDir = path.join(fixture.repoRoot, 'runtime', 'reviews-alternate');
        const aliasReviewsDir = path.join(fixture.repoRoot, 'runtime', 'reviews-alias-retarget');
        const artifactName = path.basename(fixture.outputPath);
        const aliasOutputPath = path.join(aliasReviewsDir, artifactName);
        const fsModule = require('node:fs') as { mkdirSync: typeof fs.mkdirSync };
        const originalMkdirSync = fsModule.mkdirSync;
        let manifestLockAttempts = 0;
        try {
            const result = executeSemanticCycleRebindTransaction(fixture.options);
            assert.equal(result.status, 'COMMITTED');
            fs.mkdirSync(alternateReviewsDir);
            fs.copyFileSync(fixture.outputPath, path.join(alternateReviewsDir, artifactName));
            try {
                fs.symlinkSync(
                    physicalReviewsDir,
                    aliasReviewsDir,
                    process.platform === 'win32' ? 'junction' : 'dir'
                );
            } catch {
                context.skip('Directory symlink or junction creation is unavailable in this environment.');
                return;
            }
            fsModule.mkdirSync = ((directoryPath: fs.PathLike, options?: fs.MakeDirectoryOptions) => {
                if (path.resolve(String(directoryPath)) === path.resolve(`${aliasOutputPath}.lock`)) {
                    manifestLockAttempts += 1;
                }
                return originalMkdirSync(directoryPath, options);
            }) as typeof fsModule.mkdirSync;

            const reads = withReviewArtifactReadBarrier(physicalReviewsDir, () => {
                const first = readSemanticCycleRebindManifest(fixture.repoRoot, aliasOutputPath);
                fs.rmSync(aliasReviewsDir, { recursive: true, force: true });
                fs.symlinkSync(
                    alternateReviewsDir,
                    aliasReviewsDir,
                    process.platform === 'win32' ? 'junction' : 'dir'
                );
                const retargeted = readSemanticCycleRebindManifest(fixture.repoRoot, aliasOutputPath);
                fs.rmSync(aliasReviewsDir, { recursive: true, force: true });
                fs.symlinkSync(
                    physicalReviewsDir,
                    aliasReviewsDir,
                    process.platform === 'win32' ? 'junction' : 'dir'
                );
                const restored = readSemanticCycleRebindManifest(fixture.repoRoot, aliasOutputPath);
                return { first, restored, retargeted };
            });

            assert.equal(reads.first.status, 'VALID');
            assert.equal(reads.retargeted.status, 'INVALID');
            assert.equal(reads.restored.status, 'INVALID');
            assert.equal(manifestLockAttempts, 0);
        } finally {
            fsModule.mkdirSync = originalMkdirSync;
            fixture.cleanup();
        }
    });

    it('uses one canonical snapshot when an alias review root is still missing', (context) => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-semantic-missing-alias-'));
        const physicalRuntimeDir = path.join(repoRoot, 'physical-runtime');
        const aliasRuntimeDir = path.join(repoRoot, 'alias-runtime');
        const physicalReviewsDir = path.join(physicalRuntimeDir, 'reviews');
        const aliasReviewsDir = path.join(aliasRuntimeDir, 'reviews');
        const physicalManifestPath = path.join(physicalReviewsDir, 'T-1015-2-semantic-cycle-rebind.json');
        fs.mkdirSync(physicalRuntimeDir, { recursive: true });
        try {
            try {
                fs.symlinkSync(
                    physicalRuntimeDir,
                    aliasRuntimeDir,
                    process.platform === 'win32' ? 'junction' : 'dir'
                );
            } catch {
                context.skip('Directory symlink or junction creation is unavailable in this environment.');
                return;
            }

            const persisted = withReviewArtifactReadBarrier(
                aliasReviewsDir,
                () => readSemanticCycleRebindManifest(repoRoot, physicalManifestPath)
            );

            assert.equal(persisted.status, 'INVALID');
            assert.match(persisted.violations.join(' '), /manifest is missing/u);
            assert.equal(fs.existsSync(physicalReviewsDir), false);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('keeps nested manifests on the lock path after reading through an inner alias', (context) => {
        const fixture = createFixture();
        const reviewsDir = path.dirname(fixture.outputPath);
        const nestedDir = path.join(reviewsDir, 'nested');
        const aliasTargetDir = path.join(reviewsDir, 'alias-target');
        const nestedAliasDir = path.join(nestedDir, 'alias');
        const aliasProbePath = path.join(nestedAliasDir, 'probe.json');
        const nestedOutputPath = path.join(nestedDir, path.basename(fixture.outputPath));
        const fsModule = require('node:fs') as { mkdirSync: typeof fs.mkdirSync };
        const originalMkdirSync = fsModule.mkdirSync;
        let manifestLockAttempts = 0;
        try {
            const result = executeSemanticCycleRebindTransaction(fixture.options);
            assert.equal(result.status, 'COMMITTED');
            fs.mkdirSync(nestedDir);
            fs.mkdirSync(aliasTargetDir);
            fs.writeFileSync(path.join(aliasTargetDir, 'probe.json'), '{"probe":true}\n', 'utf8');
            try {
                fs.symlinkSync(
                    aliasTargetDir,
                    nestedAliasDir,
                    process.platform === 'win32' ? 'junction' : 'dir'
                );
            } catch {
                context.skip('Directory symlink or junction creation is unavailable in this environment.');
                return;
            }
            fs.copyFileSync(fixture.outputPath, nestedOutputPath);
            fs.writeFileSync(`${nestedOutputPath}.pending`, 'transaction pending\n', 'utf8');
            fsModule.mkdirSync = ((directoryPath: fs.PathLike, options?: fs.MakeDirectoryOptions) => {
                if (path.resolve(String(directoryPath)) === path.resolve(`${nestedOutputPath}.lock`)) {
                    manifestLockAttempts += 1;
                }
                return originalMkdirSync(directoryPath, options);
            }) as typeof fsModule.mkdirSync;

            const persisted = withReviewArtifactReadBarrier(
                reviewsDir,
                () => {
                    const probe = readReviewArtifactFileSnapshot(aliasProbePath);
                    assert.equal(probe.valid, true);
                    assert.equal(isReviewArtifactReadBarrierParticipant(nestedOutputPath), false);
                    return readSemanticCycleRebindManifest(fixture.repoRoot, nestedOutputPath);
                }
            );

            assert.equal(persisted.status, 'INVALID');
            assert.match(persisted.violations.join(' '), /incomplete transaction marker/u);
            assert.ok(manifestLockAttempts > 0);
        } finally {
            fsModule.mkdirSync = originalMkdirSync;
            fixture.cleanup();
        }
    });

    it('revokes detached barrier authority and keeps the lock during an unrelated snapshot', async () => {
        const fixture = createFixture();
        const fsModule = require('node:fs') as { mkdirSync: typeof fs.mkdirSync };
        const originalMkdirSync = fsModule.mkdirSync;
        let manifestLockAttempts = 0;
        let releaseDetachedRead!: () => void;
        const detachedReadHold = new Promise<void>((resolve) => {
            releaseDetachedRead = resolve;
        });
        let detachedRead!: Promise<ReturnType<typeof readSemanticCycleRebindManifest>>;
        let releaseSnapshot!: () => void;
        const snapshotHold = new Promise<void>((resolve) => {
            releaseSnapshot = resolve;
        });
        let markSnapshotReady!: () => void;
        const snapshotReady = new Promise<void>((resolve) => {
            markSnapshotReady = resolve;
        });
        try {
            const result = executeSemanticCycleRebindTransaction(fixture.options);
            assert.equal(result.status, 'COMMITTED');
            fsModule.mkdirSync = ((directoryPath: fs.PathLike, options?: fs.MakeDirectoryOptions) => {
                if (path.resolve(String(directoryPath)) === path.resolve(`${fixture.outputPath}.lock`)) {
                    manifestLockAttempts += 1;
                }
                return originalMkdirSync(directoryPath, options);
            }) as typeof fsModule.mkdirSync;

            withReviewArtifactReadBarrier(path.dirname(fixture.outputPath), () => {
                detachedRead = (async () => {
                    await detachedReadHold;
                    return readSemanticCycleRebindManifest(fixture.repoRoot, fixture.outputPath);
                })();
            });

            const unrelatedSnapshot = withReviewArtifactReadSnapshot(
                path.dirname(fixture.outputPath),
                async () => {
                    markSnapshotReady();
                    await snapshotHold;
                }
            );
            await snapshotReady;
            releaseDetachedRead();
            const persisted = await detachedRead;
            assert.equal(persisted.status, 'VALID');
            assert.ok(manifestLockAttempts > 0);
            releaseSnapshot();
            await unrelatedSnapshot;
        } finally {
            fsModule.mkdirSync = originalMkdirSync;
            releaseDetachedRead();
            releaseSnapshot();
            fixture.cleanup();
        }
    });

    it('fails closed on pending marker entries inside the review barrier', () => {
        const fixture = createFixture();
        const pendingPath = `${fixture.outputPath}.pending`;
        try {
            const result = executeSemanticCycleRebindTransaction(fixture.options);
            assert.equal(result.status, 'COMMITTED');

            const assertPendingMarkerRejected = (): void => {
                const persisted = withReviewArtifactReadBarrier(
                    path.dirname(fixture.outputPath),
                    () => readSemanticCycleRebindManifest(fixture.repoRoot, fixture.outputPath)
                );
                assert.equal(persisted.status, 'INVALID');
                assert.match(persisted.violations.join(' '), /incomplete transaction marker/u);
            };

            fs.writeFileSync(pendingPath, '{"schema_version":1}\n', 'utf8');
            assertPendingMarkerRejected();
            fs.rmSync(pendingPath, { force: true });
            fs.mkdirSync(pendingPath);
            assertPendingMarkerRejected();
        } finally {
            fixture.cleanup();
        }
    });

    it('invalidates cached pending-marker absence after an owned publication', () => {
        const fixture = createFixture();
        const pendingPath = `${fixture.outputPath}.pending`;
        try {
            const result = executeSemanticCycleRebindTransaction(fixture.options);
            assert.equal(result.status, 'COMMITTED');

            const statuses = withReviewArtifactReadBarrier(
                path.dirname(fixture.outputPath),
                () => {
                    const first = readSemanticCycleRebindManifest(fixture.repoRoot, fixture.outputPath);
                    writeReviewArtifactText(pendingPath, 'transaction pending\n', {
                        lowNoiseRuntimeWrites: true
                    });
                    const second = readSemanticCycleRebindManifest(fixture.repoRoot, fixture.outputPath);
                    return { first, second };
                }
            );

            assert.equal(statuses.first.status, 'VALID');
            assert.equal(statuses.second.status, 'INVALID');
            assert.match(statuses.second.violations.join(' '), /incomplete transaction marker/u);
            assert.equal(fs.existsSync(pendingPath), true);
        } finally {
            fixture.cleanup();
        }
    });

    it('keeps an observed pending marker invalid and rejects the barrier after its lookup becomes missing', () => {
        const fixture = createFixture();
        const pendingPath = `${fixture.outputPath}.pending`;
        const fsModule = require('node:fs') as { lstatSync: typeof fs.lstatSync };
        const originalLstatSync = fsModule.lstatSync;
        let pendingLookupIsMissing = false;
        try {
            const result = executeSemanticCycleRebindTransaction(fixture.options);
            assert.equal(result.status, 'COMMITTED');
            fs.writeFileSync(pendingPath, 'transaction pending\n', 'utf8');
            fsModule.lstatSync = ((candidate: fs.PathLike, options?: unknown) => {
                if (pendingLookupIsMissing && path.resolve(String(candidate)) === path.resolve(pendingPath)) {
                    const error = new Error('simulated pending-marker deletion') as NodeJS.ErrnoException;
                    error.code = 'ENOENT';
                    throw error;
                }
                return originalLstatSync(candidate, options as never);
            }) as typeof fsModule.lstatSync;

            const statuses: ReturnType<typeof readSemanticCycleRebindManifest>[] = [];
            assert.throws(
                () => withReviewArtifactReadBarrier(path.dirname(fixture.outputPath), () => {
                    statuses.push(readSemanticCycleRebindManifest(fixture.repoRoot, fixture.outputPath));
                    pendingLookupIsMissing = true;
                    statuses.push(readSemanticCycleRebindManifest(fixture.repoRoot, fixture.outputPath));
                    statuses.push(readSemanticCycleRebindManifest(fixture.repoRoot, fixture.outputPath));
                }),
                /Review artifact read snapshot was invalidated by a concurrent review publication\./u
            );

            assert.equal(statuses.length, 3);
            for (const persisted of statuses) {
                assert.equal(persisted.status, 'INVALID');
                assert.match(persisted.violations.join(' '), /incomplete transaction marker/u);
            }
            assert.equal(fs.existsSync(pendingPath), true);
            pendingLookupIsMissing = false;
            const freshRead = withReviewArtifactReadBarrier(
                path.dirname(fixture.outputPath),
                () => readSemanticCycleRebindManifest(fixture.repoRoot, fixture.outputPath)
            );
            assert.equal(freshRead.status, 'INVALID');
            assert.match(freshRead.violations.join(' '), /incomplete transaction marker/u);
        } finally {
            fsModule.lstatSync = originalLstatSync;
            fixture.cleanup();
        }
    });

    it('fails closed on missing and invalid manifests inside the review barrier', () => {
        const fixture = createFixture();
        const readInsideBarrier = () => withReviewArtifactReadBarrier(
            path.dirname(fixture.outputPath),
            () => readSemanticCycleRebindManifest(fixture.repoRoot, fixture.outputPath)
        );
        try {
            const missing = readInsideBarrier();
            assert.equal(missing.status, 'INVALID');
            assert.match(missing.violations.join(' '), /manifest is missing/u);

            fs.mkdirSync(path.dirname(fixture.outputPath), { recursive: true });
            fs.writeFileSync(fixture.outputPath, '{not-json}\n', 'utf8');
            const invalid = readInsideBarrier();
            assert.equal(invalid.status, 'INVALID');
            assert.match(invalid.violations.join(' '), /not valid JSON/u);
        } finally {
            fixture.cleanup();
        }
    });

    it('rejects changed evidence for each artifact class without exposing a partial rebind', () => {
        for (const artifactClass of SEMANTIC_CYCLE_REBIND_ARTIFACT_CLASSES) {
            const fixture = createFixture();
            try {
                fs.appendFileSync(fixture.artifactPaths[artifactClass], 'tampered\n', 'utf8');
                const result = executeSemanticCycleRebindTransaction(fixture.options);
                assert.equal(result.status, 'INVALIDATED', artifactClass);
                assert.equal(result.mutation_allowed, false, artifactClass);
                assert.equal(result.route, 'existing_recovery', artifactClass);
                assert.ok(result.audit.invalidation_codes.includes('ARTIFACT_HASH_MISMATCH'), artifactClass);
                assert.deepEqual(result.manifest?.artifacts, [], artifactClass);
                assert.equal(readSemanticCycleRebindManifest(fixture.repoRoot, fixture.outputPath).status, 'VALID');
            } finally {
                fixture.cleanup();
            }
        }
    });

    it('invalidates a typed non-reusable comparison into the existing recovery route', () => {
        const fixture = createFixture();
        try {
            const candidate = buildSemanticCycleSnapshot({
                task_id: fixture.snapshot.task_id,
                runtime,
                lifecycle_position: fixture.snapshot.lifecycle_position,
                bindings: {
                    task_contract: fixture.snapshot.bindings.task_contract,
                    profile_policy: fixture.snapshot.bindings.profile_policy,
                    workflow_config: fixture.snapshot.bindings.workflow_config,
                    rule_pack: fixture.snapshot.bindings.rule_pack,
                    review_catalog: fixture.snapshot.bindings.review_catalog,
                    trust_boundary_analysis: fixture.snapshot.bindings.trust_boundary_analysis,
                    authorized_scope: fixture.snapshot.bindings.authorized_scope,
                    source_content: hash('changed source'),
                    tree_state: fixture.snapshot.bindings.tree_state,
                    compile_evidence: fixture.snapshot.bindings.compile_evidence,
                    full_suite_evidence: fixture.snapshot.bindings.full_suite_evidence
                },
                review_lanes: fixture.snapshot.review_lanes
            });
            const comparison = compareSemanticCycleSnapshots(fixture.snapshot, candidate, runtime);
            const result = executeSemanticCycleRebindTransaction({
                ...fixture.options,
                comparison,
                candidate_snapshot: candidate
            });
            assert.equal(result.status, 'INVALIDATED');
            assert.equal(result.route, 'existing_recovery');
            assert.ok(result.audit.invalidation_codes.includes('COMPARISON_NOT_REUSABLE'));
            assert.match(result.audit.violations.join(' '), /status=RECOVERY_REQUIRED/u);
            assert.deepEqual(result.manifest?.artifacts, []);
        } finally {
            fixture.cleanup();
        }
    });

    it('rejects concurrent artifact drift before committing a rebind', () => {
        const fixture = createFixture();
        try {
            const result = executeSemanticCycleRebindTransaction({
                ...fixture.options,
                _testHooks: {
                    now_utc: () => fixedNow,
                    before_final_validation: () => {
                        fs.appendFileSync(fixture.artifactPaths.compile, 'concurrent drift\n', 'utf8');
                    }
                }
            });
            assert.equal(result.status, 'INVALIDATED');
            assert.equal(result.route, 'existing_recovery');
            assert.ok(result.audit.invalidation_codes.includes('CONCURRENT_DRIFT'));
            assert.deepEqual(result.manifest?.artifacts, []);
        } finally {
            fixture.cleanup();
        }
    });

    it('rejects an unauthorized output path without overwriting the target', () => {
        const fixture = createFixture();
        try {
            const protectedPath = path.join(fixture.repoRoot, 'src', 'control.ts');
            fs.mkdirSync(path.dirname(protectedPath), { recursive: true });
            fs.writeFileSync(protectedPath, 'export const protectedControl = true;\n', 'utf8');
            const protectedBytes = fs.readFileSync(protectedPath, 'utf8');

            const result = executeSemanticCycleRebindTransaction({
                ...fixture.options,
                output_path: protectedPath
            });

            assert.equal(result.status, 'INVALIDATED');
            assert.equal(result.mutation_allowed, false);
            assert.ok(result.audit.invalidation_codes.includes('ARTIFACT_COVERAGE_INVALID'));
            assert.equal(fs.readFileSync(protectedPath, 'utf8'), protectedBytes);
            assert.equal(result.artifact_path, fixture.outputPath);
        } finally {
            fixture.cleanup();
        }
    });

    it('rejects forged lifecycle positions outside the authenticated task-event chain', () => {
        const fixture = createFixture();
        try {
            const result = executeSemanticCycleRebindTransaction({
                ...fixture.options,
                source_position: {
                    cycle_sha256: hash('forged-source-cycle'),
                    task_event_sequence: 20
                },
                target_position: {
                    cycle_sha256: hash('forged-target-cycle'),
                    task_event_sequence: 40
                }
            });

            assert.equal(result.status, 'INVALIDATED');
            assert.equal(result.mutation_allowed, false);
            assert.equal(result.route, 'existing_recovery');
            assert.ok(result.audit.invalidation_codes.includes('LIFECYCLE_POSITION_INVALID'));
            assert.deepEqual(result.manifest?.artifacts, []);
        } finally {
            fixture.cleanup();
        }
    });

    it('rejects a valid task-event anchor that is not authenticated by the authoritative snapshot', () => {
        const fixture = createFixture();
        try {
            const nextLifecycleSha256 = appendIntegrityEvent(
                fixture.taskEventsPath,
                3,
                fixture.lifecycleHashes[1]
            );
            const result = executeSemanticCycleRebindTransaction({
                ...fixture.options,
                source_position: {
                    cycle_sha256: fixture.lifecycleHashes[1],
                    task_event_sequence: 2
                },
                target_position: {
                    cycle_sha256: nextLifecycleSha256,
                    task_event_sequence: 3
                }
            });

            assert.equal(result.status, 'INVALIDATED');
            assert.ok(result.audit.invalidation_codes.includes('LIFECYCLE_POSITION_INVALID'));
            assert.match(
                result.audit.violations.join(' '),
                /must exactly match the lifecycle position authenticated by the authoritative snapshot/u
            );
        } finally {
            fixture.cleanup();
        }
    });

    it('rejects a case-variant task-event authority file on case-sensitive filesystems', (context) => {
        const fixture = createFixture();
        try {
            const caseVariantPath = path.join(
                fixture.repoRoot,
                'runtime',
                'task-events',
                't-1015-2.jsonl'
            );
            if (fs.existsSync(caseVariantPath)) {
                context.skip('The temporary filesystem is case-insensitive.');
                return;
            }
            fs.copyFileSync(fixture.taskEventsPath, caseVariantPath);

            const result = executeSemanticCycleRebindTransaction({
                ...fixture.options,
                task_events_path: caseVariantPath
            });

            assert.equal(result.status, 'INVALIDATED');
            assert.equal(result.mutation_allowed, false);
            assert.ok(result.audit.invalidation_codes.includes('LIFECYCLE_POSITION_INVALID'));
            assert.match(result.audit.violations.join(' '), /canonical task-events path/u);
        } finally {
            fixture.cleanup();
        }
    });

    it('rejects stale lifecycle authority when the task-event chain advances before commit', () => {
        const fixture = createFixture();
        try {
            const result = executeSemanticCycleRebindTransaction({
                ...fixture.options,
                _testHooks: {
                    now_utc: () => fixedNow,
                    before_final_validation: () => {
                        appendIntegrityEvent(fixture.taskEventsPath, 3, fixture.lifecycleHashes[1]);
                    }
                }
            });

            assert.equal(result.status, 'INVALIDATED');
            assert.equal(result.mutation_allowed, false);
            assert.equal(result.route, 'existing_recovery');
            assert.ok(result.audit.invalidation_codes.includes('CONCURRENT_DRIFT'));
            assert.match(result.audit.violations.join(' '), /Lifecycle authority/u);
            assert.deepEqual(result.manifest?.artifacts, []);
        } finally {
            fixture.cleanup();
        }
    });

    it('rolls back a partial transaction when post-commit verification fails', () => {
        const fixture = createFixture();
        try {
            const result = executeSemanticCycleRebindTransaction({
                ...fixture.options,
                _testHooks: {
                    now_utc: () => fixedNow,
                    after_persist_before_verification: () => {
                        fs.appendFileSync(fixture.artifactPaths.review_receipt, 'concurrent drift\n', 'utf8');
                    }
                }
            });
            assert.equal(result.status, 'INTERRUPTED');
            assert.equal(result.mutation_allowed, false);
            assert.equal(result.audit.rollback_performed, true);
            assert.equal(result.audit.rollback_completed, true);
            assert.ok(result.audit.invalidation_codes.includes('POST_COMMIT_VALIDATION_FAILED'));
            assert.equal(fs.existsSync(fixture.outputPath), false);
        } finally {
            fixture.cleanup();
        }
    });

    it('keeps a failed rollback manifest unreadable when output removal fails', () => {
        const fixture = createFixture();
        try {
            const result = executeSemanticCycleRebindTransaction({
                ...fixture.options,
                _testHooks: {
                    now_utc: () => fixedNow,
                    after_persist_before_verification: () => {
                        fs.appendFileSync(fixture.artifactPaths.review_receipt, 'concurrent drift\n', 'utf8');
                    },
                    rollback_remove_output: () => {
                        throw new Error('simulated output removal failure');
                    }
                }
            });

            assert.equal(result.status, 'INTERRUPTED');
            assert.equal(result.mutation_allowed, false);
            assert.equal(result.audit.rollback_performed, true);
            assert.equal(result.audit.rollback_completed, false);
            assert.equal(fs.existsSync(fixture.outputPath), true);
            assert.equal(fs.existsSync(`${fixture.outputPath}.pending`), true);
            const persisted = readSemanticCycleRebindManifest(fixture.repoRoot, fixture.outputPath);
            assert.equal(persisted.status, 'INVALID');
            assert.match(persisted.violations.join(' '), /incomplete transaction marker/u);

            const replay = executeSemanticCycleRebindTransaction(fixture.options);
            assert.equal(replay.status, 'INVALIDATED');
            assert.equal(fs.existsSync(`${fixture.outputPath}.pending`), true);
        } finally {
            fixture.cleanup();
        }
    });

    it('rolls back a tampered manifest during post-persist authentication', () => {
        const fixture = createFixture();
        try {
            const result = executeSemanticCycleRebindTransaction({
                ...fixture.options,
                _testHooks: {
                    now_utc: () => fixedNow,
                    after_persist_before_verification: () => {
                        fs.writeFileSync(fixture.outputPath, '{"tampered":true}\n', 'utf8');
                    }
                }
            });
            assert.equal(result.status, 'INTERRUPTED');
            assert.equal(result.mutation_allowed, false);
            assert.equal(result.audit.rollback_performed, true);
            assert.equal(result.audit.rollback_completed, true);
            assert.ok(result.audit.invalidation_codes.includes('POST_COMMIT_VALIDATION_FAILED'));
            assert.equal(fs.existsSync(fixture.outputPath), false);
        } finally {
            fixture.cleanup();
        }
    });

    it('rolls back output when persisted manifest validation fails after the atomic write', () => {
        const fixture = createFixture();
        try {
            const result = executeSemanticCycleRebindTransaction({
                ...fixture.options,
                _testHooks: {
                    now_utc: () => fixedNow,
                    after_write_before_persisted_validation: (outputPath) => {
                        fs.writeFileSync(outputPath, '{"corrupt":true}\n', 'utf8');
                    }
                }
            });
            assert.equal(result.status, 'INTERRUPTED');
            assert.equal(result.mutation_allowed, false);
            assert.equal(result.audit.rollback_performed, true);
            assert.equal(result.audit.rollback_completed, true);
            assert.ok(result.audit.invalidation_codes.includes('PERSISTENCE_FAILED'));
            assert.equal(fs.existsSync(fixture.outputPath), false);
        } finally {
            fixture.cleanup();
        }
    });

    it('recovers idempotently after an interrupted pre-persist attempt', () => {
        const fixture = createFixture();
        try {
            const interrupted = executeSemanticCycleRebindTransaction({
                ...fixture.options,
                _testHooks: {
                    now_utc: () => fixedNow,
                    before_persist: () => {
                        throw new Error('simulated interruption');
                    }
                }
            });
            assert.equal(interrupted.status, 'INTERRUPTED');
            assert.equal(fs.existsSync(fixture.outputPath), false);

            const committed = executeSemanticCycleRebindTransaction(fixture.options);
            assert.equal(committed.status, 'COMMITTED');
            const bytes = fs.readFileSync(fixture.outputPath, 'utf8');
            const idempotent = executeSemanticCycleRebindTransaction(fixture.options);
            assert.equal(idempotent.status, 'IDEMPOTENT');
            assert.equal(idempotent.manifest?.transaction_sha256, committed.manifest?.transaction_sha256);
            assert.equal(fs.readFileSync(fixture.outputPath, 'utf8'), bytes);
        } finally {
            fixture.cleanup();
        }
    });

    it('clears a valid marker-only interruption and commits the requested transaction', () => {
        const fixture = createFixture();
        try {
            fs.mkdirSync(path.dirname(fixture.outputPath), { recursive: true });
            fs.writeFileSync(`${fixture.outputPath}.pending`, `${JSON.stringify({
                schema_version: 1,
                transaction_sha256: hash('interrupted marker-only transaction')
            })}\n`, 'utf8');

            const result = executeSemanticCycleRebindTransaction(fixture.options);

            assert.equal(result.status, 'COMMITTED');
            assert.equal(fs.existsSync(`${fixture.outputPath}.pending`), false);
            assert.equal(readSemanticCycleRebindManifest(fixture.repoRoot, fixture.outputPath).status, 'VALID');
        } finally {
            fixture.cleanup();
        }
    });

    it('finalizes a fully written interrupted transaction after revalidating its evidence', () => {
        const fixture = createFixture();
        try {
            const interrupted = executeSemanticCycleRebindTransaction({
                ...fixture.options,
                _testHooks: {
                    now_utc: () => fixedNow,
                    after_write_before_persisted_validation: () => {
                        throw new Error('simulated process interruption after manifest write');
                    },
                    rollback_remove_output: () => {
                        throw new Error('simulated process termination before rollback');
                    }
                }
            });
            assert.equal(interrupted.status, 'INTERRUPTED');
            assert.equal(fs.existsSync(fixture.outputPath), true);
            assert.equal(fs.existsSync(`${fixture.outputPath}.pending`), true);

            const recovered = executeSemanticCycleRebindTransaction(fixture.options);

            assert.equal(recovered.status, 'IDEMPOTENT');
            assert.equal(recovered.mutation_allowed, true);
            assert.equal(fs.existsSync(`${fixture.outputPath}.pending`), false);
            assert.equal(readSemanticCycleRebindManifest(fixture.repoRoot, fixture.outputPath).status, 'VALID');
        } finally {
            fixture.cleanup();
        }
    });

    it('rejects stale source evidence when replaying a committed request', () => {
        const fixture = createFixture();
        try {
            const committed = executeSemanticCycleRebindTransaction(fixture.options);
            assert.equal(committed.status, 'COMMITTED');
            const committedBytes = fs.readFileSync(fixture.outputPath, 'utf8');

            fs.appendFileSync(fixture.artifactPaths.review_context, 'stale evidence\n', 'utf8');
            const replay = executeSemanticCycleRebindTransaction(fixture.options);

            assert.equal(replay.status, 'INVALIDATED');
            assert.equal(replay.mutation_allowed, false);
            assert.equal(replay.route, 'existing_recovery');
            assert.equal(replay.artifact_path, null);
            assert.ok(replay.audit.invalidation_codes.includes('ARTIFACT_HASH_MISMATCH'));
            assert.equal(fs.readFileSync(fixture.outputPath, 'utf8'), committedBytes);
        } finally {
            fixture.cleanup();
        }
    });

    it('rejects TOCTOU drift before idempotent replay inside the output lock', () => {
        const fixture = createFixture();
        try {
            const committed = executeSemanticCycleRebindTransaction(fixture.options);
            assert.equal(committed.status, 'COMMITTED');
            const committedBytes = fs.readFileSync(fixture.outputPath, 'utf8');

            const replay = executeSemanticCycleRebindTransaction({
                ...fixture.options,
                _testHooks: {
                    now_utc: () => fixedNow,
                    after_initial_validation_before_lock: () => {
                        fs.appendFileSync(fixture.artifactPaths.review_receipt, 'TOCTOU drift\n', 'utf8');
                    }
                }
            });

            assert.equal(replay.status, 'INVALIDATED');
            assert.equal(replay.mutation_allowed, false);
            assert.equal(replay.route, 'existing_recovery');
            assert.equal(replay.artifact_path, null);
            assert.ok(replay.audit.invalidation_codes.includes('CONCURRENT_DRIFT'));
            assert.equal(fs.readFileSync(fixture.outputPath, 'utf8'), committedBytes);
        } finally {
            fixture.cleanup();
        }
    });

    it('preserves an immutable committed audit when another request targets the same path', () => {
        const fixture = createFixture();
        try {
            const committed = executeSemanticCycleRebindTransaction(fixture.options);
            assert.equal(committed.status, 'COMMITTED');
            const bytes = fs.readFileSync(fixture.outputPath, 'utf8');
            const conflict = executeSemanticCycleRebindTransaction({
                ...fixture.options,
                target_position: {
                    cycle_sha256: hash('another-target-cycle'),
                    task_event_sequence: 41
                }
            });
            assert.equal(conflict.status, 'INVALIDATED');
            assert.ok(conflict.audit.invalidation_codes.includes('IMMUTABLE_OUTPUT_CONFLICT'));
            assert.equal(conflict.artifact_path, null);
            assert.equal(fs.readFileSync(fixture.outputPath, 'utf8'), bytes);
        } finally {
            fixture.cleanup();
        }
    });

    it('rejects tampered or schema-expanded transaction audit evidence', () => {
        const fixture = createFixture();
        try {
            const result = executeSemanticCycleRebindTransaction(fixture.options);
            assert.equal(result.status, 'COMMITTED');
            const tampered = structuredClone(result.manifest!);
            tampered.audit.verified_artifact_count = 5;
            const tamperedValidation = validateSemanticCycleRebindManifest(tampered);
            assert.equal(tamperedValidation.status, 'INVALID');
            assert.match(tamperedValidation.violations.join(' '), /verify every rebound artifact/u);

            const expanded = {
                ...structuredClone(result.manifest!),
                synthetic_reviewer_identity: 'agent:forged'
            } as unknown as Record<string, unknown>;
            expanded.transaction_sha256 = computeSemanticCycleRebindManifestSha256(
                expanded as unknown as Parameters<typeof computeSemanticCycleRebindManifestSha256>[0]
            );
            assert.match(
                validateSemanticCycleRebindManifest(expanded).violations.join(' '),
                /unsupported field/u
            );
        } finally {
            fixture.cleanup();
        }
    });

    it('rejects null required cryptographic bindings even when mirror fields and hashes are recomputed', () => {
        const fixture = createFixture();
        try {
            const result = executeSemanticCycleRebindTransaction(fixture.options);
            assert.equal(result.status, 'COMMITTED');

            for (const key of [
                'transaction_id',
                'request_sha256',
                'comparison_decision_sha256',
                'authoritative_snapshot_sha256',
                'candidate_snapshot_sha256',
                'lifecycle_authority_sha256',
                'transaction_sha256'
            ] as const) {
                const tampered = structuredClone(result.manifest!);
                (tampered as unknown as Record<string, unknown>)[key] = null;
                if (key in tampered.audit) {
                    (tampered.audit as unknown as Record<string, unknown>)[key] = null;
                }
                if (key !== 'transaction_sha256') {
                    tampered.transaction_sha256 = computeSemanticCycleRebindManifestSha256(tampered);
                }

                const validation = validateSemanticCycleRebindManifest(tampered);
                assert.equal(validation.status, 'INVALID', key);
                assert.match(validation.violations.join(' '), new RegExp(key, 'u'), key);
            }
        } finally {
            fixture.cleanup();
        }
    });

    it('commits and independently validates every artifact in a multi-lane review set', () => {
        const fixture = createFixture(['code', 'security']);
        try {
            const result = executeSemanticCycleRebindTransaction(fixture.options);
            assert.equal(result.status, 'COMMITTED');
            assert.equal(result.audit.verified_artifact_count, 10);
            for (const artifactClass of [
                'review_context',
                'findings_disposition',
                'review_receipt',
                'reviewer_dependency'
            ] as const) {
                assert.equal(result.audit.artifact_class_counts[artifactClass], 2);
            }
        } finally {
            fixture.cleanup();
        }

        const tamperedFixture = createFixture(['code', 'security']);
        try {
            fs.appendFileSync(
                tamperedFixture.reviewArtifactPaths.security.reviewer_dependency,
                'tampered security lane\n',
                'utf8'
            );
            const result = executeSemanticCycleRebindTransaction(tamperedFixture.options);
            assert.equal(result.status, 'INVALIDATED');
            assert.ok(result.audit.invalidation_codes.includes('ARTIFACT_HASH_MISMATCH'));
            assert.match(result.audit.violations.join(' '), /content hash changed/u);
        } finally {
            tamperedFixture.cleanup();
        }
    });
});
