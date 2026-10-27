import { prepareRuntimeMutationGenerationCode } from '../../gate-runtime/runtime-mutation-generation';
import { prepareTaskEventSummaryCode } from '../../gate-runtime/timeline/task-events-io-summary';
import { captureLoadedCodeClosure } from '../../core/loaded-code-identity';
/** Fixed Q4 owner roots; the common authority binds actual loaded source plus fresh code bytes. */
export function capturePersistedDerivationCode(): string {
    // Producer-only lazy requires must have identical edges in a cold read process.
    // Prepare code only; no producer, scheduler or filesystem mutation is invoked.
    prepareRuntimeMutationGenerationCode();
    prepareTaskEventSummaryCode();
    return captureLoadedCodeClosure('garda.sealed-quality-code.v1', [
        require.resolve('../../core/derivation-observation-recorder'), require.resolve('./persisted-quality-operation')
    ]).sha256;
}
