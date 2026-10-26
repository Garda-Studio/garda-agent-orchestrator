import { buildLeafTestDeltaClassification } from './next-step-benchmark-remediation-fixture';
import { sha256RedactedJsonPayload } from '../../../../src/core/redaction';
import { resolveAuthoritativeReviewRemediationDecision } from '../../../../src/gates/review-remediation/review-remediation-recovery-routing';
import { fileSha256 } from './next-step-review-cycle-fixtures';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    ALL_REVIEW_FLAGS, TASK_ID, appendEvent, eventsRoot, makeTempRepo,
    reviewsRoot, seedStartedTask, writePreflight, writeReviewEvidence
} from './next-step-review-cycle-fixtures';
import { seedCompilePass } from './next-step-doc-impact-fixtures';

/** Fixed workload, shared by the real navigator budget test and process benchmark. */
export function createNextStepLongHistoryFixture(cycles = 16): { repoRoot: string; taskId: string; timelineBytes: number } {
    const repoRoot = makeTempRepo();
    const changedFiles = Array.from({ length: 64 }, (_, i) => `src/file-${String(i).padStart(2, '0')}.ts`);
    for (const [index, file] of changedFiles.entries()) {
        fs.writeFileSync(path.join(repoRoot, file), `export const value${index} = ${index};\n`);
    }
    seedStartedTask(repoRoot, TASK_ID);
    const preflightPath = writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true }, { changedFiles });
    seedCompilePass(repoRoot, TASK_ID);
    for (let cycle = 0; cycle < cycles; cycle += 1) {
        const baselineSource = fs.readFileSync(path.join(repoRoot, changedFiles[0]), 'utf8');
        const delta = buildLeafTestDeltaClassification({ repoRoot, taskId: TASK_ID, reviewType: 'code',
            changedFile: changedFiles[0], preflightPath, preflightSha256: fileSha256(preflightPath),
            profilePolicySnapshot: JSON.parse(fs.readFileSync(preflightPath, 'utf8')).profile_policy_snapshot });
        fs.writeFileSync(path.join(repoRoot, changedFiles[0]), baselineSource);
        const classification = { source: 'runtime_fix' as const, classification: {
            category: 'production', reason: 'Retained benchmark remediation cycle.',
            blocked_before_reuse: false, invalidated_review_types: ['code']
        } };
        const decision = resolveAuthoritativeReviewRemediationDecision({ taskId: TASK_ID, currentReviewType: 'code',
            classification, requiredReviews: { code: true }, reviewExecutionPolicyMode: 'code_first_optional' });
        const bound = { ...decision, preflight_sha256: fileSha256(preflightPath) };
        const { decision_sha256: _oldHash, ...payload } = bound;
        appendEvent(repoRoot, TASK_ID, 'REVIEW_CYCLE_RESTARTED', 'PASS', {
            task_id: TASK_ID, event_type: 'REVIEW_CYCLE_RESTARTED', status: 'PASSED',
            preflight_sha256: fileSha256(preflightPath), authoritative_review_classification: classification,
            retained_delta: delta, authoritative_review_decision: { ...payload, decision_sha256: sha256RedactedJsonPayload(payload) }
        });
        writeReviewEvidence(repoRoot, TASK_ID, 'code');
        const historyRoot = path.join(reviewsRoot(repoRoot), 'benchmark-history', String(cycle));
        fs.mkdirSync(historyRoot, { recursive: true });
        for (const suffix of ['code-review-context.json', 'code-receipt.json', 'code.md', 'code-remediation-baseline.json']) {
            fs.copyFileSync(path.join(reviewsRoot(repoRoot), `${TASK_ID}-${suffix}`), path.join(historyRoot, suffix));
        }
        for (let entry = 0; entry < 40; entry += 1) {
            appendEvent(repoRoot, TASK_ID, 'BENCHMARK_HISTORY_RECORDED', 'INFO', {
                cycle, entry, retained_note: 'Deterministic retained review history. '.repeat(64)
            }, new Date(Date.UTC(2026, 0, 1, 0, cycle, entry)).toISOString());
        }
    }
    const timelineBytes = fs.statSync(path.join(eventsRoot(repoRoot), `${TASK_ID}.jsonl`)).size;
    return { repoRoot, taskId: TASK_ID, timelineBytes };
}
