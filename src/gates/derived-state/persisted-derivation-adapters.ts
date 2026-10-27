import * as path from 'node:path';
import * as childProcess from 'node:child_process';
import { readInvocationFileContent, readInvocationPathObservation } from '../../core/invocation-file-observation';
import { readNativeRealpath } from '../../core/paths';
import { readInvocationFilteredDirectoryNames } from '../../core/invocation-enumeration-observation';
import { captureInvocationMemoTrace, observeDerivationInput, fingerprintObservationData,
    type ObservationTrace, type RecordedObservation } from '../../core/derivation-observation-recorder';
import { countNextStepWork } from '../../core/next-step-measurement';
import { outsideInvocationReadObservation, registerInvocationDependency, createInvocationReadMemoKey, inheritParentInvocationLeafMemo, memoizeInvocationRead } from '../../core/invocation-read-observation';
import { resolveClosedReviewAuthentication, type ClosedReviewAuthentication } from '../review-attempts/review-closed-cycle-auth';
import { inspectTrustedWindowsWriteAuthority } from '../../gate-runtime/timeline/windows-acl-authority';
import { readTaskTimelinePersistedQualityQuery } from '../../gate-runtime/timeline/task-events-integrity';
import { capturePersistedDerivationCode } from './persisted-derivation-code';
import { derivationHash, isDerivationHash } from '../../core/persisted-derivation-value';

export interface PersistentDependency {
    kind: string; version: 1; input: Record<string, unknown>; inputSha256: string; fingerprint: string;
}
const nativeSpawn = childProcess.spawnSync;
function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
    const actual = Object.keys(value); return actual.length === keys.length && actual.every(key => keys.includes(key));
}
function absolute(value: unknown): value is string { return typeof value === 'string' && value.length < 32768 && path.isAbsolute(value); }
export function serializableDependency(value: unknown): value is PersistentDependency {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const d = value as PersistentDependency;
    if (!exactKeys(d as unknown as Record<string, unknown>, ['kind','version','input','inputSha256','fingerprint'])
        || d.version !== 1 || typeof d.kind !== 'string' || typeof d.fingerprint !== 'string' || d.fingerprint.length > 256
        || !isDerivationHash(d.inputSha256) || !d.input || typeof d.input !== 'object' || Array.isArray(d.input)) return false;
    const input = d.input;
    if (fingerprintObservationData(input) !== d.inputSha256) return false;
    switch (d.kind) {
        case 'file-bytes': case 'path-state': case 'native-realpath':
            return exactKeys(input, ['path']) && absolute(input.path);
        case 'directory-enumeration':
            return exactKeys(input, ['path','prefix','suffix','order']) && absolute(input.path)
                && typeof input.prefix === 'string' && typeof input.suffix === 'string' && ['native','sorted'].includes(String(input.order));
        case 'acl-verdict':
            return exactKeys(input, ['path','platform','environmentSha256']) && absolute(input.path)
                && input.platform === process.platform && isDerivationHash(input.environmentSha256);
        case 'timeline-query':
            return exactKeys(input, ['query','path','taskId']) && input.query === 'quality-leaf-v1'
                && absolute(input.path) && typeof input.taskId === 'string';
        case 'workspace-auth': return exactKeys(input, ['repoRoot']) && absolute(input.repoRoot);
        case 'code-closure': return exactKeys(input, ['closure']) && input.closure === 'sealed-quality-v1';
        case 'process-query': return exactKeys(input, ['query','repoRoot','environmentSha256','platform'])
            && input.query === 'git-head-v1' && absolute(input.repoRoot) && isDerivationHash(input.environmentSha256)
            && input.platform === process.platform;
        // Generic process-result contains full env/command metadata and has no serialized native replay.
        // Absence is already represented by path-state's exact native ENOENT/ENOTDIR outcome.
        default: return false;
    }
}
export function encodePersistentDependencies(trace: ObservationTrace): PersistentDependency[] | null {
    if (trace.nonCacheableReasons.length) return null;
    const result: PersistentDependency[] = [];
    for (const observation of trace.observations) {
        countNextStepWork('visit:q4_encode_dependency');
        if (observation.kind === 'process-result') return null; // Never copy its plaintext environment.
        const dependency: PersistentDependency = { kind: observation.kind, version: observation.version as 1,
            input: observation.input as Record<string, unknown>, inputSha256: fingerprintObservationData(observation.input),
            fingerprint: observation.fingerprint };
        if (!serializableDependency(dependency)) return null;
        result.push(dependency);
    }
    return result;
}
function authFingerprint(auth: ClosedReviewAuthentication): string {
    return fingerprintObservationData({ repo: auth.repoRealpath, git: auth.gitDirectoryRealpath,
        workspace: auth.workspaceSha256, keySha256: derivationHash(auth.key) });
}
export function observePersistentWorkspaceAuth(repoRoot: string): ClosedReviewAuthentication {
    const auth = observeDerivationInput('workspace-auth', 1, { repoRoot: path.resolve(repoRoot) },
        () => resolveClosedReviewAuthentication(repoRoot, false), authFingerprint);
    registerInvocationDependency(auth, () => {
        const fresh = outsideInvocationReadObservation(() => resolveClosedReviewAuthentication(repoRoot, false));
        if (authFingerprint(auth) !== authFingerprint(fresh)) throw new Error('Invocation derivation authentication changed.');
    });
    return auth;
}
const CODE_OBSERVATION = createInvocationReadMemoKey<string>('persistent-code-closure');
export function observePersistentCode(): string {
    inheritParentInvocationLeafMemo(CODE_OBSERVATION, '');
    return memoizeInvocationRead(CODE_OBSERVATION, '', () => observeDerivationInput('code-closure', 1, { closure: 'sealed-quality-v1' }, capturePersistedDerivationCode, value => value)).value;
}
export function observePersistentQualityQuery(file: string, taskId: string) {
    return observeDerivationInput('timeline-query', 1, { query: 'quality-leaf-v1', path: path.resolve(file), taskId }, () => {
        const query = readTaskTimelinePersistedQualityQuery(file, taskId);
        if (!query) throw new Error('Quality persistence requires a verified current cycle.');
        return query;
    }, fingerprintObservationData);
}
/** One reconstructible readonly command. No caller argv/env/options are admitted. */
export function observePersistentGitHead(repoRoot: string): string | null {
    const environmentSha256 = fingerprintObservationData(process.env);
    const input = { query: 'git-head-v1', repoRoot: path.resolve(repoRoot), environmentSha256, platform: process.platform };
    const read = () => {
        if (fingerprintObservationData(process.env) !== environmentSha256) throw new Error('Git query environment changed.');
        const result = nativeSpawn('git', ['rev-parse', '--verify', 'HEAD'], { cwd: input.repoRoot,
            encoding: 'utf8', timeout: 10000, maxBuffer: 65536, windowsHide: true });
        return { status: result.status, signal: result.signal, stdout: String(result.stdout || ''),
            stderr: String(result.stderr || ''), code: result.error ? String((result.error as NodeJS.ErrnoException).code || '') : null };
    };
    const result = observeDerivationInput('process-query', 1, input, read, fingerprintObservationData);
    const expected = fingerprintObservationData(result);
    registerInvocationDependency(result, () => {
        if (fingerprintObservationData(read()) !== expected) throw new Error('Invocation fixed Git query changed.');
    });
    return result.status === 0 ? result.stdout.trim() : null;
}
function invokeReplay(d: PersistentDependency): void {
    const input = d.input;
    switch (d.kind) {
        case 'path-state': readInvocationPathObservation(String(input.path)); return;
        case 'file-bytes': readInvocationFileContent(String(input.path)); return;
        case 'native-realpath': readNativeRealpath(String(input.path)); return;
        case 'directory-enumeration': readInvocationFilteredDirectoryNames(String(input.path),
            { prefix: String(input.prefix), suffix: String(input.suffix), sort: input.order === 'sorted' }); return;
        case 'acl-verdict':
            if (fingerprintObservationData(process.env) !== input.environmentSha256) throw new Error('ACL environment changed.');
            inspectTrustedWindowsWriteAuthority(String(input.path)); return;
        case 'timeline-query': observePersistentQualityQuery(String(input.path), String(input.taskId)); return;
        case 'workspace-auth': observePersistentWorkspaceAuth(String(input.repoRoot)); return;
        case 'code-closure': observePersistentCode(); return;
        case 'process-query':
            if (fingerprintObservationData(process.env) !== input.environmentSha256) throw new Error('Git environment changed.');
            observePersistentGitHead(String(input.repoRoot)); return;
        default: throw new Error('Unknown persistent dependency.');
    }
}
export function replayPersistentDependencies(dependencies: readonly PersistentDependency[]): boolean {
    for (const dependency of dependencies) {
        countNextStepWork('visit:q4_replayed_dependency');
        if (!serializableDependency(dependency)) return false;
        const captured = captureInvocationMemoTrace(() => invokeReplay(dependency));
        // A native throw may itself be the expected recorded outcome (e.g. realpath absence).
        if (captured.trace.nonCacheableReasons.length) return false;
        const match = captured.trace.observations.find((observation: RecordedObservation) => {
            countNextStepWork('visit:q4_replay_trace_match');
            return observation.kind === dependency.kind && observation.version === dependency.version
                && fingerprintObservationData(observation.input) === dependency.inputSha256;
        });
        if (!match || match.fingerprint !== dependency.fingerprint) return false;
    }
    return true;
}
