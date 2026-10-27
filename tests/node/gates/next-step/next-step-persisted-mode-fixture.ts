import assert from 'node:assert/strict';
import { withPersistentDerivationMode, type PersistentDerivationMode } from '../../../../src/core/persisted-derivation-mode';
import { measureHistoryRoute, type HistoryRouteMeasurement } from './next-step-authenticated-budget-fixture';
import type { AuthenticatedHistoryFixture } from './next-step-authenticated-history-fixture';
export interface PersistentModeRouteMeasurement extends HistoryRouteMeasurement {
    persistenceMode: PersistentDerivationMode; persistenceHits: number; persistenceMisses: number;
}
/** Call at each existing fixture state. It never constructs/replays native history itself. */
export function measurePersistedHistoryModes(state: AuthenticatedHistoryFixture, route: string): PersistentModeRouteMeasurement[] {
    const measuredModes = (['disabled', 'force-miss', 'ordinary'] as const).map(persistenceMode => {
        const measured = withPersistentDerivationMode(persistenceMode, () => measureHistoryRoute(state, route));
        return { ...measured, persistenceMode, persistenceHits: measured.counters.q4_hit || 0,
            persistenceMisses: measured.counters.q4_miss || 0 };
    });
    const [disabled, miss, ordinary] = measuredModes;
    assert.equal(disabled.persistenceHits, 0, route + ': disabled has no hits');
    assert.equal(miss.persistenceHits, 0, route + ': forced miss has no hits');
    const eligible = route === 'active-review' || route === 'required-reviews-check'
        || (disabled.counters.q4_disabled || 0) > 0;
    if (eligible) {
        assert.ok((disabled.counters.q4_disabled || 0) > 0, route + ': real quality derivation must run');
        assert.ok(miss.persistenceMisses > 0, route + ': real forced miss required');
        assert.ok(ordinary.persistenceHits > 0, route + ': ordinary mode must actually reuse an authenticated record');
    }
    for (const measured of [miss, ordinary]) {
        assert.equal(measured.outputJsonSha256, disabled.outputJsonSha256, route + ': complete JSON output parity');
        assert.equal(measured.outputTextSha256, disabled.outputTextSha256, route + ': complete text output parity');
    }
    return measuredModes;
}
