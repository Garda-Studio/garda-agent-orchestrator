import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

import { appendTaskEvent } from '../../../../src/gate-runtime/task-events';
import { runCompletionGate } from '../../../../src/gates/completion';
import { collectRequiredReviewEvidence } from '../../../../src/gates/completion/completion-required-review-evidence';
import { buildDomainScopeFingerprints } from '../../../../src/gates/scope/domain-scope-fingerprints';
import {
    PROJECT_MEMORY_IMPACT_ASSESSED_EVENT,
    assessProjectMemoryImpact
} from '../../../../src/gates/project-memory-impact';
import { buildDefaultWorkflowConfig } from '../../../../src/core/workflow-config';
import { PROJECT_MEMORY_REQUIRED_FILE_NAMES } from '../../../../src/core/project-memory';
import { normalizeReviewCatalog } from '../../../../src/core/review-catalog';
import type { ReviewCapabilitiesConfigMap } from '../../../../src/core/review-capabilities';
import {
    buildEffectiveReviewSnapshot,
    type FrozenReviewExecutionPolicyBinding
} from '../../../../src/policy/effective-review-snapshot';
import { resolveProfileReviewCatalogPolicy } from '../../../../src/policy/profile-review-catalog-policy';
import {
    createTempRepo,
    getOrchestratorRoot,
    getReviewsRoot,
    loadPostPreflightRulePack,
    loadTaskEntryRulePack,
    runEnterTaskMode as runBaseEnterTaskMode,
    runHandshakeForTask,
    runShellSmokeForTask,
    seedInitAnswers,
    seedTaskQueue,
    writeBalancedProfilesConfig,
    writeCompilePassEvidence,
    writePreflight,
    writeReceiptBackedReviewArtifact
} from '../../cli/commands/gate-test-helpers';
import {
    rewriteValidationExecutionBinding,
    writeSchema4ReviewPackage
} from '../review/review-execution-lineage-test-fixture';

function fileSha256(filePath: string): string {
    return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function writeJson(filePath: string, payload: unknown): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
}

function canonicalize(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map(canonicalize);
    }
    if (value && typeof value === 'object') {
        return Object.keys(value as Record<string, unknown>)
            .sort()
            .reduce<Record<string, unknown>>((result, key) => {
                result[key] = canonicalize((value as Record<string, unknown>)[key]);
                return result;
            }, {});
    }
    return value;
}

function rehashSnapshot(snapshot: Record<string, unknown>): void {
    const body = Object.fromEntries(Object.entries(snapshot).filter(([key]) => key !== 'snapshot_sha256'));
    snapshot.snapshot_sha256 = createHash('sha256')
        .update(JSON.stringify(canonicalize(body)), 'utf8')
        .digest('hex');
}

function rehashGraph(graph: Record<string, unknown>): void {
    const body = Object.fromEntries(Object.entries(graph).filter(([key]) => key !== 'graph_sha256'));
    graph.graph_sha256 = createHash('sha256')
        .update(JSON.stringify(canonicalize(body)), 'utf8')
        .digest('hex');
}

function runEnterTaskMode(
    options: Parameters<typeof runBaseEnterTaskMode>[0]
): ReturnType<typeof runBaseEnterTaskMode> {
    assert.ok(options.repoRoot);
    const profilesPath = writeBalancedProfilesConfig(options.repoRoot);
    const profiles = JSON.parse(fs.readFileSync(profilesPath, 'utf8')) as Record<string, unknown>;
    const builtInProfiles = profiles.built_in_profiles as Record<string, Record<string, unknown>>;
    const reviewPolicy = builtInProfiles.balanced.review_policy as Record<string, boolean | 'auto'>;
    reviewPolicy.code = 'auto';
    writeJson(profilesPath, profiles);
    const result = runBaseEnterTaskMode(options);
    const reviewsRoot = getReviewsRoot(options.repoRoot);
    const preflightPath = path.join(reviewsRoot, `${options.taskId}-preflight.json`);
    const taskModePath = path.join(reviewsRoot, `${options.taskId}-task-mode.json`);
    const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
    const taskMode = JSON.parse(fs.readFileSync(taskModePath, 'utf8')) as Record<string, unknown>;
    const taskProfileSnapshot = taskMode.profile_policy_snapshot as Record<string, unknown>;
    const frozenReviewPolicy = taskProfileSnapshot.review_execution_policy as FrozenReviewExecutionPolicyBinding;
    const profileSource = taskProfileSnapshot.source as Record<string, unknown>;
    const laneSelection = taskProfileSnapshot.review_lane_selection as Record<string, unknown>;
    const catalog = normalizeReviewCatalog({
        version: 1,
        custom_review_types: []
    }, { knownSkillIds: [] });
    const profilePolicy = resolveProfileReviewCatalogPolicy(
        String(profileSource.effective_profile),
        laneSelection.profile_review_policy as Record<string, boolean | 'auto'>,
        laneSelection.review_capabilities as ReviewCapabilitiesConfigMap,
        catalog
    );
    const changedFiles = Array.isArray(preflight.changed_files)
        ? preflight.changed_files.map(String)
        : [];
    const taskTriggers = Object.fromEntries(
        Object.entries(preflight.triggers as Record<string, unknown> | undefined ?? {})
            .filter((entry): entry is [string, boolean] => typeof entry[1] === 'boolean')
    );
    const snapshot = buildEffectiveReviewSnapshot({
        catalog,
        profilePolicy,
        profileSnapshotSha256: String(taskProfileSnapshot.snapshot_hash),
        legacyRequiredReviews: preflight.required_reviews as Record<string, boolean>,
        scopeCategory: String(preflight.scope_category || 'code'),
        taskIntent: String(options.taskSummary || 'Validate completion review trust'),
        changedFiles,
        taskTriggers,
        zeroDiffBaselineOnly: false,
        reviewExecutionPolicyMode: frozenReviewPolicy.mode,
        reviewDependencyGraph: frozenReviewPolicy.review_dependency_graph,
        fullSuiteValidation: frozenReviewPolicy.full_suite_validation
    });
    preflight.profile_policy_snapshot = taskProfileSnapshot;
    preflight.effective_review_snapshot = snapshot;
    preflight.review_execution_policy = {
        ...(preflight.review_execution_policy as Record<string, unknown> | undefined ?? {}),
        mode: frozenReviewPolicy.mode,
        dependency_graph: snapshot.review_dependency_graph
    };
    preflight.required_reviews = snapshot.required_reviews;
    writeJson(preflightPath, preflight);
    return result;
}

function writeProjectMemoryWorkflowConfig(repoRoot: string, enabled = true): void {
    const config = buildDefaultWorkflowConfig();
    config.full_suite_validation.enabled = false;
    config.full_suite_validation.command = 'npm test';
    config.review_execution_policy = { mode: 'code_first_optional' };
    config.project_memory_maintenance.enabled = enabled;
    config.project_memory_maintenance.mode = 'check';
    config.project_memory_maintenance.run_before_final_closeout = true;
    writeJson(path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json'), config);
}

function seedProjectMemory(repoRoot: string): void {
    const memoryRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'docs', 'project-memory');
    fs.mkdirSync(memoryRoot, { recursive: true });
    for (const fileName of PROJECT_MEMORY_REQUIRED_FILE_NAMES) {
        fs.writeFileSync(path.join(memoryRoot, fileName), `# ${fileName}\n\nConfirmed project memory content.\n`, 'utf8');
    }
}

function recordCurrentProjectMemoryImpact(repoRoot: string, taskId: string, preflightPath: string): void {
    const result = assessProjectMemoryImpact({ repoRoot, taskId, preflightPath });
    writeJson(result.artifactPath, result.artifact);
    appendTaskEvent(
        getOrchestratorRoot(repoRoot),
        taskId,
        PROJECT_MEMORY_IMPACT_ASSESSED_EVENT,
        'PASS',
        'Project memory impact gate assessed memory impact.',
        result.artifact
    );
}

describe('gates/completion review trust', () => {
    it('rejects missing and self-rehashed frozen dependency graphs before completion', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904c-completion-frozen-graph';

        try {
            seedTaskQueue(repoRoot, taskId);
            seedInitAnswers(repoRoot, 'Codex');
            writeProjectMemoryWorkflowConfig(repoRoot, false);
            const preflightPath = writePreflight(repoRoot, taskId, {
                scope_category: 'code',
                required_reviews: { code: true, test: true }
            });
            runEnterTaskMode({
                repoRoot,
                taskId,
                taskSummary: 'Reject forged frozen dependency graphs at completion',
                provider: 'Codex',
                routedTo: 'AGENTS.md'
            });
            const original = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;

            const missing = JSON.parse(JSON.stringify(original)) as Record<string, unknown>;
            const missingSnapshot = missing.effective_review_snapshot as Record<string, unknown>;
            delete missingSnapshot.review_dependency_graph;
            delete (missing.review_execution_policy as Record<string, unknown>).dependency_graph;
            rehashSnapshot(missingSnapshot);
            writeJson(preflightPath, missing);
            assert.throws(
                () => runCompletionGate({ repoRoot, preflightPath, taskId }),
                /dependency graph does not match the canonical frozen task profile graph|dependency graph is required by the frozen task profile policy/u
            );

            const forged = JSON.parse(JSON.stringify(original)) as Record<string, unknown>;
            const forgedSnapshot = forged.effective_review_snapshot as Record<string, unknown>;
            const forgedGraph = forgedSnapshot.review_dependency_graph as Record<string, unknown>;
            (forgedGraph.dependencies as Record<string, string[]>).test = [];
            forgedGraph.preparation_batches = [['code', 'test']];
            rehashGraph(forgedGraph);
            rehashSnapshot(forgedSnapshot);
            (forged.review_execution_policy as Record<string, unknown>).dependency_graph = forgedGraph;
            writeJson(preflightPath, forged);
            assert.throws(
                () => runCompletionGate({ repoRoot, preflightPath, taskId }),
                /dependency graph does not match the canonical frozen task profile graph/u
            );
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('keeps frozen full-suite enablement authoritative after live workflow drift at completion', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904c-completion-full-suite-drift';

        try {
            seedTaskQueue(repoRoot, taskId);
            seedInitAnswers(repoRoot, 'Codex');
            const workflowConfigPath = path.join(
                repoRoot,
                'garda-agent-orchestrator',
                'live',
                'config',
                'workflow-config.json'
            );
            const frozenConfig = buildDefaultWorkflowConfig();
            frozenConfig.review_execution_policy = { mode: 'test_after_code' };
            frozenConfig.full_suite_validation.enabled = true;
            frozenConfig.full_suite_validation.placement = 'before_test_review';
            frozenConfig.project_memory_maintenance.enabled = false;
            writeJson(workflowConfigPath, frozenConfig);
            const preflightPath = writePreflight(repoRoot, taskId, {
                scope_category: 'code',
                required_reviews: { code: true, test: true }
            });
            runEnterTaskMode({
                repoRoot,
                taskId,
                taskSummary: 'Keep frozen full-suite completion policy',
                provider: 'Codex',
                routedTo: 'AGENTS.md'
            });
            const liveConfig = JSON.parse(fs.readFileSync(workflowConfigPath, 'utf8')) as Record<string, unknown>;
            liveConfig.full_suite_validation = {
                ...(liveConfig.full_suite_validation as Record<string, unknown>),
                enabled: false,
                placement: 'after_compile_before_reviews'
            };
            writeJson(workflowConfigPath, liveConfig);

            const result = runCompletionGate({ repoRoot, preflightPath, taskId });

            assert.equal(result.full_suite_validation_evidence.enabled, true);
            assert.equal(result.full_suite_validation_evidence.status, 'MISSING');
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('accepts a stale receipt when its review domain matches from the repository root', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904c-completion-domain-root';

        try {
            seedTaskQueue(repoRoot, taskId);
            seedInitAnswers(repoRoot, 'Codex');
            const preflightPath = writePreflight(repoRoot, taskId);
            runEnterTaskMode({
                repoRoot,
                taskId,
                taskSummary: 'Validate completion receipt-domain repository root',
                provider: 'Codex',
                routedTo: 'AGENTS.md'
            });
            writeReceiptBackedReviewArtifact(
                repoRoot,
                taskId,
                'code',
                'REVIEW PASSED',
                undefined,
                { allowLegacyManualReviewContext: true }
            );

            const reviewsRoot = getReviewsRoot(repoRoot);
            const receiptPath = path.join(reviewsRoot, `${taskId}-code-receipt.json`);
            const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8')) as Record<string, unknown>;
            const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
            assert.match(String(receipt.review_execution_contract_sha256 || ''), /^[a-f0-9]{64}$/u);
            receipt.preflight_sha256 = 'a'.repeat(64);
            receipt.domain_scope_fingerprints = buildDomainScopeFingerprints({
                repoRoot,
                detectionSource: String(preflight.detection_source || 'git_auto'),
                includeUntracked: preflight.include_untracked !== false,
                changedFiles: preflight.changed_files as string[]
            });
            writeJson(receiptPath, receipt);
            const reviewEvidencePath = path.join(reviewsRoot, `${taskId}-review-gate.json`);
            writeJson(reviewEvidencePath, {
                task_id: taskId,
                status: 'PASSED',
                outcome: 'PASS'
            });

            const errors: string[] = [];
            const result = collectRequiredReviewEvidence({
                reviewsRoot,
                taskId,
                preflight,
                preflightPath,
                preflightSha256: fileSha256(preflightPath),
                reviewEvidencePath,
                requiredReviews: preflight.required_reviews as Record<string, unknown>,
                scopeCategory: 'code',
                orderedEvents: [],
                errors
            });

            assert.equal(
                result.receiptReviewTrustSummary?.status,
                'INDEPENDENT_AUDITED',
                errors.join('\n')
            );
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('rejects stale schema-4 receipt and findings-validation execution lineage', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-992-completion-execution-lineage';

        try {
            seedTaskQueue(repoRoot, taskId);
            seedInitAnswers(repoRoot, 'Codex');
            writeProjectMemoryWorkflowConfig(repoRoot, false);
            const preflightPath = writePreflight(repoRoot, taskId, {
                scope_category: 'code',
                required_reviews: { code: true }
            });
            runEnterTaskMode({
                repoRoot,
                taskId,
                taskSummary: 'Reject stale completion execution lineage',
                provider: 'Codex',
                routedTo: 'AGENTS.md'
            });
            const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
            const reviewsRoot = getReviewsRoot(repoRoot);
            const reviewEvidencePath = path.join(reviewsRoot, `${taskId}-review-gate.json`);
            writeJson(reviewEvidencePath, { task_id: taskId, status: 'PASSED', outcome: 'PASS' });
            const collectErrors = (): string[] => {
                const errors: string[] = [];
                collectRequiredReviewEvidence({
                    reviewsRoot,
                    taskId,
                    preflight,
                    preflightPath,
                    preflightSha256: fileSha256(preflightPath),
                    reviewEvidencePath,
                    requiredReviews: preflight.required_reviews as Record<string, unknown>,
                    scopeCategory: 'code',
                    orderedEvents: [],
                    errors
                });
                return errors;
            };
            let reviewPackage = writeSchema4ReviewPackage({
                reviewsRoot,
                repoRoot,
                taskId,
                reviewType: 'code',
                preflightPath,
                preflight
            });
            const receipt = JSON.parse(fs.readFileSync(reviewPackage.receiptPath, 'utf8')) as Record<string, unknown>;
            delete receipt.review_execution_complete_scope_lineage_sha256;
            writeJson(reviewPackage.receiptPath, receipt);

            assert.ok(collectErrors().some((error) =>
                error.includes('review receipt is missing valid review_execution_complete_scope_lineage_sha256')
            ));

            reviewPackage = writeSchema4ReviewPackage({
                reviewsRoot,
                repoRoot,
                taskId,
                reviewType: 'code',
                preflightPath,
                preflight
            });
            rewriteValidationExecutionBinding({
                reviewPackage,
                field: 'review_execution_finding_reconciliation_sha256',
                value: '9'.repeat(64)
            });

            assert.ok(collectErrors().some((error) =>
                error.includes('review findings validation artifact execution binding')
                && error.includes('review_execution_finding_reconciliation_sha256')
            ));
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('does not fall back to receipt-derived independent trust when current review gate is incomplete', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904c-completion-trust-gate';

        try {
            seedTaskQueue(repoRoot, taskId);
            seedInitAnswers(repoRoot, 'Codex');
            writeProjectMemoryWorkflowConfig(repoRoot, false);
            const preflightPath = writePreflight(repoRoot, taskId, {
                scope_category: 'code',
                required_reviews: {
                    code: true,
                    db: false,
                    security: false,
                    refactor: false,
                    api: false,
                    test: false,
                    performance: false,
                    infra: false,
                    dependency: false
                }
            });

            runEnterTaskMode({
                repoRoot,
                taskId,
                taskSummary: 'Validate completion review trust fallback',
                provider: 'Codex',
                routedTo: 'AGENTS.md'
            });
            assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
            runHandshakeForTask(repoRoot, taskId);
            runShellSmokeForTask(repoRoot, taskId);
            assert.equal(loadPostPreflightRulePack(repoRoot, taskId, preflightPath).exitCode, 0);
            appendTaskEvent(getOrchestratorRoot(repoRoot), taskId, 'IMPLEMENTATION_STARTED', 'INFO', 'Implementation started.', {
                preflight_path: preflightPath.replace(/\\/g, '/')
            });
            writeCompilePassEvidence(repoRoot, taskId, preflightPath);
            writeReceiptBackedReviewArtifact(
                repoRoot,
                taskId,
                'code',
                'REVIEW PASSED'
            );

            const reviewsRoot = getReviewsRoot(repoRoot);
            const preflightHash = fileSha256(preflightPath);
            writeJson(path.join(reviewsRoot, `${taskId}-review-gate.json`), {
                task_id: taskId,
                status: 'PASSED',
                outcome: 'PASS',
                preflight_hash_sha256: preflightHash,
                required_reviews: { code: true },
                verdicts: { code: 'REVIEW PASSED' },
                review_checks: {
                    code: {
                        required: true,
                        skipped_by_override: false,
                        verdict: 'REVIEW PASSED',
                        pass_token: 'REVIEW PASSED',
                        receipt_valid: true,
                        reviewer_execution_mode: 'delegated_subagent',
                        reviewer_identity: 'agent:code-reviewer',
                        reviewer_fallback_reason: null,
                        trust_level: 'INDEPENDENT_AUDITED'
                    }
                }
            });
            appendTaskEvent(getOrchestratorRoot(repoRoot), taskId, 'REVIEW_GATE_PASSED', 'PASS', 'Review gate passed.', {
                preflight_hash_sha256: preflightHash,
                required_reviews: { code: true }
            });

            writeJson(path.join(reviewsRoot, `${taskId}-doc-impact.json`), {
                task_id: taskId,
                status: 'PASSED',
                outcome: 'PASS',
                decision: 'NO_DOC_UPDATES',
                rationale: 'Focused completion trust regression.'
            });
            appendTaskEvent(getOrchestratorRoot(repoRoot), taskId, 'DOC_IMPACT_ASSESSED', 'PASS', 'Doc impact assessed.', {
                decision: 'NO_DOC_UPDATES'
            });

            const result = runCompletionGate({
                repoRoot,
                preflightPath,
                taskId
            });

            assert.equal(result.status, 'PASSED', JSON.stringify(result, null, 2));
            assert.equal(result.review_artifacts?.code?.receipt?.trust_level, 'INDEPENDENT_AUDITED');
            assert.equal(result.review_trust_summary?.status, 'UNAVAILABLE');
            assert.match(result.review_trust_summary?.visible_summary_line || '', /incomplete or invalid/i);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('requires current project memory impact evidence before completion when maintenance is enabled', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904c-project-memory-completion';

        try {
            seedTaskQueue(repoRoot, taskId);
            seedInitAnswers(repoRoot, 'Codex');
            writeProjectMemoryWorkflowConfig(repoRoot);
            seedProjectMemory(repoRoot);
            const preflightPath = writePreflight(repoRoot, taskId, {
                scope_category: 'code',
                required_reviews: {
                    code: true,
                    db: false,
                    security: false,
                    refactor: false,
                    api: false,
                    test: false,
                    performance: false,
                    infra: false,
                    dependency: false
                }
            });

            runEnterTaskMode({
                repoRoot,
                taskId,
                taskSummary: 'Validate project memory completion gate',
                provider: 'Codex',
                routedTo: 'AGENTS.md'
            });
            assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
            runHandshakeForTask(repoRoot, taskId);
            runShellSmokeForTask(repoRoot, taskId);
            assert.equal(loadPostPreflightRulePack(repoRoot, taskId, preflightPath).exitCode, 0);
            appendTaskEvent(getOrchestratorRoot(repoRoot), taskId, 'IMPLEMENTATION_STARTED', 'INFO', 'Implementation started.', {
                preflight_path: preflightPath.replace(/\\/g, '/')
            });
            writeCompilePassEvidence(repoRoot, taskId, preflightPath);
            writeReceiptBackedReviewArtifact(
                repoRoot,
                taskId,
                'code',
                'REVIEW PASSED'
            );

            const reviewsRoot = getReviewsRoot(repoRoot);
            const preflightHash = fileSha256(preflightPath);
            writeJson(path.join(reviewsRoot, `${taskId}-review-gate.json`), {
                task_id: taskId,
                status: 'PASSED',
                outcome: 'PASS',
                preflight_hash_sha256: preflightHash,
                required_reviews: { code: true },
                verdicts: { code: 'REVIEW PASSED' },
                review_checks: {
                    code: {
                        required: true,
                        skipped_by_override: false,
                        verdict: 'REVIEW PASSED',
                        pass_token: 'REVIEW PASSED',
                        receipt_valid: true,
                        reviewer_execution_mode: 'delegated_subagent',
                        reviewer_identity: 'agent:code-reviewer',
                        reviewer_fallback_reason: null,
                        trust_level: 'INDEPENDENT_AUDITED'
                    }
                }
            });
            appendTaskEvent(getOrchestratorRoot(repoRoot), taskId, 'REVIEW_GATE_PASSED', 'PASS', 'Review gate passed.', {
                preflight_hash_sha256: preflightHash,
                required_reviews: { code: true }
            });

            writeJson(path.join(reviewsRoot, `${taskId}-doc-impact.json`), {
                task_id: taskId,
                status: 'PASSED',
                outcome: 'PASS',
                decision: 'NO_DOC_UPDATES',
                rationale: 'Focused project memory completion regression.'
            });
            appendTaskEvent(getOrchestratorRoot(repoRoot), taskId, 'DOC_IMPACT_ASSESSED', 'PASS', 'Doc impact assessed.', {
                decision: 'NO_DOC_UPDATES'
            });

            const missing = runCompletionGate({ repoRoot, preflightPath, taskId });
            assert.equal(missing.status, 'FAILED');
            assert.equal(missing.project_memory_impact_evidence.evidence_status, 'MISSING');
            assert.ok(missing.violations.some((violation: string) => violation.includes('Project memory impact evidence')));

            recordCurrentProjectMemoryImpact(repoRoot, taskId, preflightPath);
            const passed = runCompletionGate({ repoRoot, preflightPath, taskId });
            assert.equal(passed.status, 'PASSED', JSON.stringify(passed, null, 2));
            assert.equal(passed.project_memory_impact_evidence.evidence_status, 'CURRENT');
            assert.equal(passed.project_memory_impact_evidence.status, 'NO_UPDATE_NEEDED');
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('rejects doc-impact project_memory_updated claims when project-memory-impact records no update', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904c-project-memory-claim-mismatch';

        try {
            seedTaskQueue(repoRoot, taskId);
            seedInitAnswers(repoRoot, 'Codex');
            writeProjectMemoryWorkflowConfig(repoRoot);
            seedProjectMemory(repoRoot);
            const preflightPath = writePreflight(repoRoot, taskId, {
                scope_category: 'code',
                required_reviews: {
                    code: true,
                    db: false,
                    security: false,
                    refactor: false,
                    api: false,
                    test: false,
                    performance: false,
                    infra: false,
                    dependency: false
                }
            });

            runEnterTaskMode({
                repoRoot,
                taskId,
                taskSummary: 'Validate project memory claim parity',
                provider: 'Codex',
                routedTo: 'AGENTS.md'
            });
            assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
            runHandshakeForTask(repoRoot, taskId);
            runShellSmokeForTask(repoRoot, taskId);
            assert.equal(loadPostPreflightRulePack(repoRoot, taskId, preflightPath).exitCode, 0);
            appendTaskEvent(getOrchestratorRoot(repoRoot), taskId, 'IMPLEMENTATION_STARTED', 'INFO', 'Implementation started.', {
                preflight_path: preflightPath.replace(/\\/g, '/')
            });
            writeCompilePassEvidence(repoRoot, taskId, preflightPath);
            writeReceiptBackedReviewArtifact(
                repoRoot,
                taskId,
                'code',
                'REVIEW PASSED',
                undefined,
                { allowLegacyManualReviewContext: true }
            );

            const reviewsRoot = getReviewsRoot(repoRoot);
            const preflightHash = fileSha256(preflightPath);
            writeJson(path.join(reviewsRoot, `${taskId}-review-gate.json`), {
                task_id: taskId,
                status: 'PASSED',
                outcome: 'PASS',
                preflight_hash_sha256: preflightHash,
                required_reviews: { code: true },
                verdicts: { code: 'REVIEW PASSED' },
                review_checks: {
                    code: {
                        required: true,
                        skipped_by_override: false,
                        verdict: 'REVIEW PASSED',
                        pass_token: 'REVIEW PASSED',
                        receipt_valid: true,
                        reviewer_execution_mode: 'delegated_subagent',
                        reviewer_identity: 'agent:code-reviewer',
                        reviewer_fallback_reason: null,
                        trust_level: 'INDEPENDENT_AUDITED'
                    }
                }
            });
            appendTaskEvent(getOrchestratorRoot(repoRoot), taskId, 'REVIEW_GATE_PASSED', 'PASS', 'Review gate passed.', {
                preflight_hash_sha256: preflightHash,
                required_reviews: { code: true }
            });

            writeJson(path.join(reviewsRoot, `${taskId}-doc-impact.json`), {
                task_id: taskId,
                status: 'PASSED',
                outcome: 'PASS',
                decision: 'NO_DOC_UPDATES',
                behavior_changed: true,
                project_memory_updated: true,
                rationale: 'Internal behavior evidence claims project memory was updated.'
            });
            appendTaskEvent(getOrchestratorRoot(repoRoot), taskId, 'DOC_IMPACT_ASSESSED', 'PASS', 'Doc impact assessed.', {
                decision: 'NO_DOC_UPDATES',
                project_memory_updated: true
            });

            recordCurrentProjectMemoryImpact(repoRoot, taskId, preflightPath);
            const result = runCompletionGate({ repoRoot, preflightPath, taskId });

            assert.equal(result.status, 'FAILED');
            assert.equal(result.project_memory_impact_evidence.status, 'NO_UPDATE_NEEDED');
            assert.ok(result.violations.some((violation: string) => violation.includes('project_memory_updated=true')));
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('accepts doc-impact project_memory_update_not_needed claims when project-memory-impact records no update', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904c-project-memory-no-update-needed';

        try {
            seedTaskQueue(repoRoot, taskId);
            seedInitAnswers(repoRoot, 'Codex');
            writeProjectMemoryWorkflowConfig(repoRoot);
            seedProjectMemory(repoRoot);
            const preflightPath = writePreflight(repoRoot, taskId, {
                changed_files: ['tests/node/gates/doc-impact/doc-impact.test.ts'],
                scope_category: 'test',
                required_reviews: {
                    code: false,
                    db: false,
                    security: false,
                    refactor: false,
                    api: false,
                    test: true,
                    performance: false,
                    infra: false,
                    dependency: false
                }
            });

            runEnterTaskMode({
                repoRoot,
                taskId,
                taskSummary: 'Validate project memory no-update-needed parity',
                provider: 'Codex',
                routedTo: 'AGENTS.md'
            });
            assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
            runHandshakeForTask(repoRoot, taskId);
            runShellSmokeForTask(repoRoot, taskId);
            assert.equal(loadPostPreflightRulePack(repoRoot, taskId, preflightPath).exitCode, 0);
            appendTaskEvent(getOrchestratorRoot(repoRoot), taskId, 'IMPLEMENTATION_STARTED', 'INFO', 'Implementation started.', {
                preflight_path: preflightPath.replace(/\\/g, '/')
            });
            writeCompilePassEvidence(repoRoot, taskId, preflightPath);
            writeReceiptBackedReviewArtifact(
                repoRoot,
                taskId,
                'test',
                'REVIEW PASSED'
            );

            const reviewsRoot = getReviewsRoot(repoRoot);
            const preflightHash = fileSha256(preflightPath);
            writeJson(path.join(reviewsRoot, `${taskId}-review-gate.json`), {
                task_id: taskId,
                status: 'PASSED',
                outcome: 'PASS',
                preflight_hash_sha256: preflightHash,
                required_reviews: { test: true },
                verdicts: { test: 'REVIEW PASSED' },
                review_checks: {
                    test: {
                        required: true,
                        skipped_by_override: false,
                        verdict: 'REVIEW PASSED',
                        pass_token: 'REVIEW PASSED',
                        receipt_valid: true,
                        reviewer_execution_mode: 'delegated_subagent',
                        reviewer_identity: 'agent:test-reviewer',
                        reviewer_fallback_reason: null,
                        trust_level: 'INDEPENDENT_AUDITED'
                    }
                }
            });
            appendTaskEvent(getOrchestratorRoot(repoRoot), taskId, 'REVIEW_GATE_PASSED', 'PASS', 'Review gate passed.', {
                preflight_hash_sha256: preflightHash,
                required_reviews: { test: true }
            });

            writeJson(path.join(reviewsRoot, `${taskId}-doc-impact.json`), {
                task_id: taskId,
                status: 'PASSED',
                outcome: 'PASS',
                decision: 'NO_DOC_UPDATES',
                behavior_changed: true,
                project_memory_update_not_needed: true,
                rationale: 'Internal behavior was checked against project memory and no update was needed.'
            });
            appendTaskEvent(getOrchestratorRoot(repoRoot), taskId, 'DOC_IMPACT_ASSESSED', 'PASS', 'Doc impact assessed.', {
                decision: 'NO_DOC_UPDATES',
                project_memory_update_not_needed: true
            });

            recordCurrentProjectMemoryImpact(repoRoot, taskId, preflightPath);
            const result = runCompletionGate({ repoRoot, preflightPath, taskId });

            assert.equal(result.status, 'PASSED', JSON.stringify(result, null, 2));
            assert.equal(result.project_memory_impact_evidence.status, 'NO_UPDATE_NEEDED');
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('accepts project-memory evidence before doc-impact when doc-impact claims project_memory_update_not_needed', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904c-project-memory-before-doc-impact';

        try {
            seedTaskQueue(repoRoot, taskId);
            seedInitAnswers(repoRoot, 'Codex');
            writeProjectMemoryWorkflowConfig(repoRoot);
            seedProjectMemory(repoRoot);
            const preflightPath = writePreflight(repoRoot, taskId, {
                changed_files: ['tests/node/gates/doc-impact/doc-impact.test.ts'],
                scope_category: 'test',
                required_reviews: {
                    code: false,
                    db: false,
                    security: false,
                    refactor: false,
                    api: false,
                    test: true,
                    performance: false,
                    infra: false,
                    dependency: false
                }
            });

            runEnterTaskMode({
                repoRoot,
                taskId,
                taskSummary: 'Validate project memory before doc-impact ordering',
                provider: 'Codex',
                routedTo: 'AGENTS.md'
            });
            assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
            runHandshakeForTask(repoRoot, taskId);
            runShellSmokeForTask(repoRoot, taskId);
            assert.equal(loadPostPreflightRulePack(repoRoot, taskId, preflightPath).exitCode, 0);
            appendTaskEvent(getOrchestratorRoot(repoRoot), taskId, 'IMPLEMENTATION_STARTED', 'INFO', 'Implementation started.', {
                preflight_path: preflightPath.replace(/\\/g, '/')
            });
            writeCompilePassEvidence(repoRoot, taskId, preflightPath);
            writeReceiptBackedReviewArtifact(
                repoRoot,
                taskId,
                'test',
                'REVIEW PASSED'
            );

            const reviewsRoot = getReviewsRoot(repoRoot);
            const preflightHash = fileSha256(preflightPath);
            writeJson(path.join(reviewsRoot, `${taskId}-review-gate.json`), {
                task_id: taskId,
                status: 'PASSED',
                outcome: 'PASS',
                preflight_hash_sha256: preflightHash,
                required_reviews: { test: true },
                verdicts: { test: 'REVIEW PASSED' },
                review_checks: {
                    test: {
                        required: true,
                        skipped_by_override: false,
                        verdict: 'REVIEW PASSED',
                        pass_token: 'REVIEW PASSED',
                        receipt_valid: true,
                        reviewer_execution_mode: 'delegated_subagent',
                        reviewer_identity: 'agent:test-reviewer',
                        reviewer_fallback_reason: null,
                        trust_level: 'INDEPENDENT_AUDITED'
                    }
                }
            });
            appendTaskEvent(getOrchestratorRoot(repoRoot), taskId, 'REVIEW_GATE_PASSED', 'PASS', 'Review gate passed.', {
                preflight_hash_sha256: preflightHash,
                required_reviews: { test: true }
            });

            recordCurrentProjectMemoryImpact(repoRoot, taskId, preflightPath);
            writeJson(path.join(reviewsRoot, `${taskId}-doc-impact.json`), {
                task_id: taskId,
                status: 'PASSED',
                outcome: 'PASS',
                decision: 'NO_DOC_UPDATES',
                behavior_changed: true,
                project_memory_update_not_needed: true,
                rationale: 'Internal behavior was checked against project memory before doc-impact closeout.'
            });
            appendTaskEvent(getOrchestratorRoot(repoRoot), taskId, 'DOC_IMPACT_ASSESSED', 'PASS', 'Doc impact assessed.', {
                decision: 'NO_DOC_UPDATES',
                project_memory_update_not_needed: true
            });

            const result = runCompletionGate({ repoRoot, preflightPath, taskId });

            assert.equal(result.status, 'PASSED', JSON.stringify(result, null, 2));
            assert.equal(result.project_memory_impact_evidence.status, 'NO_UPDATE_NEEDED');
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('rejects doc-impact project_memory_update_not_needed claims when project-memory-impact records update-needed evidence', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904c-project-memory-no-update-mismatch';

        try {
            seedTaskQueue(repoRoot, taskId);
            seedInitAnswers(repoRoot, 'Codex');
            writeProjectMemoryWorkflowConfig(repoRoot);
            seedProjectMemory(repoRoot);
            const preflightPath = writePreflight(repoRoot, taskId, {
                changed_files: ['src/gates/project-memory-impact.ts'],
                scope_category: 'code',
                required_reviews: {
                    code: true,
                    db: false,
                    security: false,
                    refactor: false,
                    api: false,
                    test: false,
                    performance: false,
                    infra: false,
                    dependency: false
                }
            });

            runEnterTaskMode({
                repoRoot,
                taskId,
                taskSummary: 'Validate project memory no-update-needed mismatch',
                provider: 'Codex',
                routedTo: 'AGENTS.md'
            });
            assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
            runHandshakeForTask(repoRoot, taskId);
            runShellSmokeForTask(repoRoot, taskId);
            assert.equal(loadPostPreflightRulePack(repoRoot, taskId, preflightPath).exitCode, 0);
            appendTaskEvent(getOrchestratorRoot(repoRoot), taskId, 'IMPLEMENTATION_STARTED', 'INFO', 'Implementation started.', {
                preflight_path: preflightPath.replace(/\\/g, '/')
            });
            writeCompilePassEvidence(repoRoot, taskId, preflightPath);
            writeReceiptBackedReviewArtifact(
                repoRoot,
                taskId,
                'code',
                'REVIEW PASSED',
                undefined,
                { allowLegacyManualReviewContext: true }
            );

            const reviewsRoot = getReviewsRoot(repoRoot);
            const preflightHash = fileSha256(preflightPath);
            writeJson(path.join(reviewsRoot, `${taskId}-review-gate.json`), {
                task_id: taskId,
                status: 'PASSED',
                outcome: 'PASS',
                preflight_hash_sha256: preflightHash,
                required_reviews: { code: true },
                verdicts: { code: 'REVIEW PASSED' },
                review_checks: {
                    code: {
                        required: true,
                        skipped_by_override: false,
                        verdict: 'REVIEW PASSED',
                        pass_token: 'REVIEW PASSED',
                        receipt_valid: true,
                        reviewer_execution_mode: 'delegated_subagent',
                        reviewer_identity: 'agent:code-reviewer',
                        reviewer_fallback_reason: null,
                        trust_level: 'INDEPENDENT_AUDITED'
                    }
                }
            });
            appendTaskEvent(getOrchestratorRoot(repoRoot), taskId, 'REVIEW_GATE_PASSED', 'PASS', 'Review gate passed.', {
                preflight_hash_sha256: preflightHash,
                required_reviews: { code: true }
            });

            writeJson(path.join(reviewsRoot, `${taskId}-doc-impact.json`), {
                task_id: taskId,
                status: 'PASSED',
                outcome: 'PASS',
                decision: 'NO_DOC_UPDATES',
                behavior_changed: true,
                project_memory_update_not_needed: true,
                rationale: 'Internal behavior claims project memory did not need updates.'
            });
            appendTaskEvent(getOrchestratorRoot(repoRoot), taskId, 'DOC_IMPACT_ASSESSED', 'PASS', 'Doc impact assessed.', {
                decision: 'NO_DOC_UPDATES',
                project_memory_update_not_needed: true
            });

            recordCurrentProjectMemoryImpact(repoRoot, taskId, preflightPath);
            const result = runCompletionGate({ repoRoot, preflightPath, taskId });

            assert.equal(result.status, 'FAILED');
            assert.ok(result.violations.some((violation: string) => violation.includes('project_memory_update_not_needed=true')));
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

});
