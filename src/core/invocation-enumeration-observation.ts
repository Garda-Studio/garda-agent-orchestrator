import * as fs from 'node:fs';
import * as path from 'node:path';
import { cloneFrozenJson } from './immutable-json';
import { readInvocationPathObservation } from './invocation-file-observation';
import { createInvocationReadMemoKey, memoizeInvocationRead, registerInvocationDependency } from './invocation-read-observation';
import { observeDerivationInput, fingerprintObservationData, markDerivationNonCacheable } from './derivation-observation-recorder';
import { countNextStepWork, describeProcessInputs } from './next-step-measurement';

export interface InvocationNameFilter { prefix?: string; suffix?: string; sort?: boolean; }
const ENUMERATIONS = createInvocationReadMemoKey<readonly string[]>('filtered-directory-enumerations');

/** Exactly this name filter is replayable; arbitrary predicate closures are intentionally unsupported. */
export function readInvocationFilteredDirectoryNames(directory: string, filter: InvocationNameFilter = {}): string[] {
    const described = describeProcessInputs(filter, kind => countNextStepWork('visit:enumeration_filter_' + kind));
    if (described.opaque) {
        markDerivationNonCacheable('opaque-enumeration-filter');
        throw new Error('Recorded directory filters require data-only parameters.');
    }
    const options = cloneFrozenJson(filter);
    if ((options.prefix !== undefined && typeof options.prefix !== 'string')
        || (options.suffix !== undefined && typeof options.suffix !== 'string')
        || (options.sort !== undefined && typeof options.sort !== 'boolean')) throw new Error('Invalid directory name filter.');
    const absolute = path.resolve(directory);
    readInvocationPathObservation(absolute);
    const input = { path: absolute, prefix: options.prefix || '', suffix: options.suffix || '', order: options.sort ? 'sorted' : 'native' };
    const read = (): readonly string[] => {
        countNextStepWork('filtered_directory_enumeration:' + absolute);
        const names = fs.readdirSync(absolute).filter(name => {
            countNextStepWork('visit:filtered_directory_candidate');
            return name.startsWith(input.prefix) && name.endsWith(input.suffix);
        });
        if (options.sort) names.sort((left, right) => {
            countNextStepWork('compare:filtered_directory_name');
            return left < right ? -1 : left > right ? 1 : 0;
        });
        return Object.freeze(names);
    };
    const names = memoizeInvocationRead(ENUMERATIONS, fingerprintObservationData(input), () => {
        const original = observeDerivationInput('directory-enumeration', 1, input, read, fingerprintObservationData);
        const expected = fingerprintObservationData(original);
        registerInvocationDependency(original, () => {
            if (fingerprintObservationData(read()) !== expected) throw new Error('Invocation filtered directory enumeration changed: ' + absolute);
        });
        return original;
    }).value;
    return names.map(name => { countNextStepWork('visit:filtered_directory_copy'); return name; });
}
