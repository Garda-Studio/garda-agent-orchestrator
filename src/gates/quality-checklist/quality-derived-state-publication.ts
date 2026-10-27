import { resolveClosedReviewAuthentication } from '../review-attempts/review-closed-cycle-auth';
import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { outsideInvocationReadObservation, withInvocationReadObservation } from '../../core/invocation-read-observation';
import { readInvocationFileContent } from '../../core/invocation-file-observation';
import { countNextStepWork } from '../../core/next-step-measurement';
import { readReviewContextTrustBoundaryAnalysis, readQualityValidationPhaseAnalysis } from '../review-context/review-context-trust-boundary-analysis';
/** Call only after the native owning transaction, canonical event and output are committed.
 * This captures a NEW read scope. It neither spans owner effects nor supplies a success/trust flag.
 */
export function publishQualityDerivationsAfterNativeOwner(repoRoot: string, taskId: string, preflightPath: string): void {
    try {
        outsideInvocationReadObservation(() => {
            resolveClosedReviewAuthentication(repoRoot, true);
            withInvocationReadObservation(() => {
                const content = readInvocationFileContent(preflightPath);
                const bytes = content ? content.copyBytes() : fs.readFileSync(preflightPath);
                const preflight: unknown = JSON.parse(bytes.toString('utf8'));
                if (!preflight || typeof preflight !== 'object' || Array.isArray(preflight)) return;
                const options = { repoRoot, taskId, preflight: preflight as Record<string, unknown>,
                    preflightSha256: createHash('sha256').update(bytes).digest('hex'), inspection: 'active' as const };
                readReviewContextTrustBoundaryAnalysis(options);
                readQualityValidationPhaseAnalysis(options);
            });
        });
    } catch { countNextStepWork('q4_owner_publication_unavailable'); }
}
