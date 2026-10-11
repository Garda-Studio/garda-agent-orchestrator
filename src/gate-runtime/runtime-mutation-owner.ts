import * as fs from 'node:fs';
import * as os from 'node:os';

import { isProcessLikelyAlive } from './timeline/task-events-locking-metadata';

/** Local kernel identity, not a distributed lease or external attestation. */
export interface RuntimeMutationOwnerIdentity {
    scheme: 'linux-proc-v1';
    hostname: string;
    boot_id: string;
    pid_namespace: string;
    pid: number;
    start_time_ticks: string;
    time_namespace?: string | null;
}

type OwnerState = 'live' | 'dead' | 'unknown';
const OWNER_KEYS = ['scheme', 'hostname', 'boot_id', 'pid_namespace', 'pid', 'start_time_ticks'];
const BOOT_ID_PATTERN = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;
const PID_NAMESPACE_PATTERN = /^pid:\[[1-9][0-9]{0,19}\]$/u;
const TIME_NAMESPACE_PATTERN = /^time:\[[1-9][0-9]{0,19}\]$/u;
const START_TICKS_PATTERN = /^[1-9][0-9]{0,19}$/u;

export function parseRuntimeMutationOwnerIdentity(value: unknown): RuntimeMutationOwnerIdentity | null {
    if (value === null) return null;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('Mutation owner identity must be an object or null.');
    }
    const owner = value as Record<string, unknown>;
    const hasTimeNamespace = Object.prototype.hasOwnProperty.call(owner, 'time_namespace');
    if (Object.keys(owner).sort().join('|') !== [...OWNER_KEYS, ...(hasTimeNamespace ? ['time_namespace'] : [])].sort().join('|')
        || owner.scheme !== 'linux-proc-v1'
        || typeof owner.hostname !== 'string' || !owner.hostname.trim() || owner.hostname.length > 255
        || typeof owner.boot_id !== 'string' || !BOOT_ID_PATTERN.test(owner.boot_id)
        || typeof owner.pid_namespace !== 'string' || !PID_NAMESPACE_PATTERN.test(owner.pid_namespace)
        || !Number.isSafeInteger(owner.pid) || Number(owner.pid) <= 0 || Number(owner.pid) > 0x7fffffff
        || typeof owner.start_time_ticks !== 'string' || !START_TICKS_PATTERN.test(owner.start_time_ticks)
        || hasTimeNamespace && owner.time_namespace !== null
            && (typeof owner.time_namespace !== 'string' || !TIME_NAMESPACE_PATTERN.test(owner.time_namespace))) {
        throw new Error('Mutation owner identity has an unverifiable shape or generation.');
    }
    const parsed: RuntimeMutationOwnerIdentity = {
        scheme: owner.scheme,
        hostname: owner.hostname,
        boot_id: owner.boot_id,
        pid_namespace: owner.pid_namespace,
        pid: owner.pid as number,
        start_time_ticks: owner.start_time_ticks
    };
    // Preserve earlier hashed owner representations without inventing a clock binding.
    if (hasTimeNamespace) parsed.time_namespace = owner.time_namespace as string | null;
    return parsed;
}

function readStartTicks(statPath: string, expectedPid: number): string {
    const stat = fs.readFileSync(statPath, 'utf8');
    const closingParenthesis = stat.lastIndexOf(')');
    // comm can contain spaces and closing parentheses; field 22 follows field 3 by 19 positions.
    const fields = stat.slice(closingParenthesis + 1).trim().split(/\s+/u);
    if (stat.length > 8192 || closingParenthesis < 0
        || !stat.startsWith(`${expectedPid} (`) || !START_TICKS_PATTERN.test(fields[19] ?? '')) {
        throw new Error('Unverifiable proc process generation.');
    }
    return fields[19];
}

function captureObserverTimeNamespace(): string | null {
    try {
        const namespace = fs.readlinkSync('/proc/self/ns/time');
        return TIME_NAMESPACE_PATTERN.test(namespace)
            && fs.readlinkSync(`/proc/${process.pid}/ns/time`) === namespace ? namespace : null;
    } catch {
        return null;
    }
}

export function captureRuntimeMutationOwnerIdentity(): RuntimeMutationOwnerIdentity | null {
    if (process.platform !== 'linux') return null;
    try {
        const startTicks = readStartTicks('/proc/self/stat', process.pid);
        const namespace = fs.readlinkSync('/proc/self/ns/pid');
        // Verify that /proc's numeric PID view agrees with the namespace used by process.kill.
        if (readStartTicks(`/proc/${process.pid}/stat`, process.pid) !== startTicks
            || fs.readlinkSync(`/proc/${process.pid}/ns/pid`) !== namespace) return null;
        return parseRuntimeMutationOwnerIdentity({
            scheme: 'linux-proc-v1',
            hostname: os.hostname(),
            boot_id: fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(),
            pid_namespace: namespace,
            pid: process.pid,
            start_time_ticks: startTicks,
            time_namespace: captureObserverTimeNamespace()
        });
    } catch {
        // Missing proc, permissions, incompatible PID views and unsupported identity stay unknown.
        return null;
    }
}

/** Capture local scope once per locked recovery scan; cache only within that scan. */
export function createRuntimeMutationOwnerProbe(): (owner: RuntimeMutationOwnerIdentity | null) => OwnerState {
    const current = captureRuntimeMutationOwnerIdentity();
    const states = new Map<string, OwnerState>();
    return (owner) => {
        if (!owner || !current
            || owner.hostname.trim().toLowerCase() !== current.hostname.trim().toLowerCase()
            || owner.boot_id !== current.boot_id || owner.pid_namespace !== current.pid_namespace) return 'unknown';
        const key = JSON.stringify(owner);
        const cached = states.get(key);
        if (cached) return cached;
        let state: OwnerState = 'unknown';
        const alive = isProcessLikelyAlive(owner.pid);
        if (alive === false) {
            state = 'dead';
        } else if (alive === true && current.time_namespace
            && owner.time_namespace === current.time_namespace) {
            try {
                const startTicks = readStartTicks(`/proc/${owner.pid}/stat`, owner.pid);
                if (fs.readlinkSync(`/proc/${owner.pid}/ns/pid`) === current.pid_namespace) {
                    state = startTicks === owner.start_time_ticks ? 'live' : 'dead';
                }
            } catch {
                // ENOENT alone can mean hidepid or a race, and is not proof of death.
            }
        }
        states.set(key, state);
        return state;
    };
}
