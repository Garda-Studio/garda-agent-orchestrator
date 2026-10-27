import { executeClosedObservationPlan, unwrapObservationCapture } from '../../core/derivation-observation-recorder';
import { describeProcessInputs } from '../../core/next-step-measurement';
import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { cloneFrozenJson, cloneJson } from '../../core/immutable-json';
import {
    isInvocationReadObservationActive, memoizeInvocationRead, type InvocationReadMemoKey
} from '../../core/invocation-read-observation';
import {
    observedInvocationValue, readInvocationFileContent, readInvocationPathObservation
} from '../../core/invocation-file-observation';

/** Only immutable private nodes are retained; public results keep their mutable-copy contract. */
export function readReviewValidationNode<T>(key: InvocationReadMemoKey<T>, identity: () => unknown, build: () => T): T {
    if (!isInvocationReadObservationActive()) return build();
    const input = describeProcessInputs(identity());
    if (input.opaque) return build();
    const node = memoizeInvocationRead(key, input.text, () => cloneFrozenJson(build()));
    return cloneJson(node.value);
}

export function readQualityArtifactLstat(filePath: string): fs.Stats {
    const observed = readInvocationPathObservation(filePath);
    return observed ? observedInvocationValue(observed.stat) : fs.lstatSync(filePath);
}

export function readQualityArtifactStat(filePath: string): fs.Stats {
    const observed = readInvocationPathObservation(filePath);
    return observed ? observedInvocationValue(observed.targetStat) : fs.statSync(filePath);
}

/** Keep the original reader's unbounded byte contract, including contained symbolic links. */
export function readReviewValidationBytes(filePath: string): Buffer {
    const observedPath = readInvocationPathObservation(filePath);
    // Preserve the original readFile error (including its syscall/path diagnostic)
    // for unavailable and non-file inputs; the path observation still binds absence/kind.
    if (observedPath && ('error' in observedPath.targetIdentity || !observedPath.targetIdentity.value.isFile()))
        return fs.readFileSync(filePath);
    const observed = readInvocationFileContent(filePath);
    if (!observed) return fs.readFileSync(filePath);
    if (observed.size <= 128 * 1024 * 1024) return observed.copyBytes();
    // Large observations retain their digest rather than their bytes. The old reader
    // accepted these files: read them natively and bind exactly those bytes to Q2.
    const bytes = fs.readFileSync(filePath);
    if (createHash('sha256').update(bytes).digest('hex') !== observed.sha256) {
        throw new Error('Quality-checklist artifact changed during invocation capture: ' + filePath);
    }
    return bytes;
}

export function parseObservedQualityArtifactJson(filePath: string, bytes: Buffer, sha256: string): unknown {
    if (!isInvocationReadObservationActive()) return JSON.parse(bytes.toString('utf8')) as unknown;
    const plan = { operation: 'quality-artifact-json' as const, path: filePath, text: bytes.toString('utf8'), sha256 };
    return cloneJson(unwrapObservationCapture(executeClosedObservationPlan(plan)));
}
