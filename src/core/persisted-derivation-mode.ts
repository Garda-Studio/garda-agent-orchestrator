import { AsyncLocalStorage } from 'node:async_hooks';
import { countNextStepWork } from './next-step-measurement';
export type PersistentDerivationMode = 'disabled' | 'force-miss' | 'ordinary';
const modes = new AsyncLocalStorage<PersistentDerivationMode>();
/** Measurement-only acceleration selection. Native checks and final A1 are never disabled. */
export function withPersistentDerivationMode<T>(mode: PersistentDerivationMode, run: () => T): T {
    return modes.run(mode, run);
}
export function persistentDerivationMode(): PersistentDerivationMode { return modes.getStore() ?? 'ordinary'; }
export function countPersistentOutcome(outcome: 'hit' | 'miss' | 'disabled' | 'noncacheable'): void {
    countNextStepWork('q4_' + outcome);
}
