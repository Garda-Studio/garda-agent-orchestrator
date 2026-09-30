import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { normalizeReviewCatalog } from '../../../../src/core/review-catalog';
import type { ReviewCapabilitiesConfigMap } from '../../../../src/core/review-capabilities';
import { buildEffectiveReviewSnapshot } from '../../../../src/policy/effective-review-snapshot';
import { resolveProfileReviewCatalogPolicy } from '../../../../src/policy/profile-review-catalog-policy';
import {
    isCustomReviewLaneInSnapshot,
    resolveReviewContextLaneBinding,
    resolveReviewCoverageCategoryIdsFromPreflight
} from '../../../../src/gates/review-context/review-context-lane';
import {
    buildReviewContextPreflightDiffExpectations,
    getReviewContextContractViolations
} from '../../../../src/gates/review-context/review-context-contract';
import {
    buildAuthoritativeReviewCoverageContract,
    resolveAuthoritativeReviewCoverageScope
} from '../../../../src/gates/review-context/review-context-coverage';
import { buildScopedDiff } from '../../../../src/gates/preflight/build-scoped-diff';
import { resolveCatalogReviewSkillBinding } from '../../../../src/gates/review-context/build-review-context';
import { buildReviewCoverageContract } from '../../../../src/gates/review/review-coverage-ledger';
import { buildReviewReceipt } from '../../../../src/gate-runtime/review-context';
import { fileSha256 } from '../../../../src/gate-runtime/hash';
import {
    buildReviewFindingsValidationArtifact,
    getReviewFindingsValidationArtifactPath
} from '../../../../src/gates/review/review-findings-validation-artifact';
import { validateReviewFindingsContract } from '../../../../src/gates/review/review-findings-artifact-verdict';
import { resolveReviewContextExecutionEvidenceBindings } from '../../../../src/gates/review/review-evidence-contract';
import type {
    ReviewRemediationReviewContract
} from '../../../../src/gates/review-remediation/review-remediation-review-contract';
import { buildFocusedRecoveryCoverageContractSha256 } from '../../../../src/gates/next-step/next-step';
import { getReusedReviewCoverageContractViolations } from '../../../../src/gates/review-reuse/review-reuse-materialization';
import { buildReviewCoverageAuditSummary } from '../../../../src/gates/task-audit/task-audit-summary-review-coverage';
import {
    emitGeneratedReviewContextPreparationTelemetry
} from '../../../../src/cli/commands/gate-flows/review-context/review-context-telemetry';
import {
    buildReviewContext,
    runGit,
    writeTaskModeArtifactFixture
} from './build-review-context-fixtures';

function buildCustomPreflight(profileState: boolean | 'auto' = true): Record<string, unknown> {
    const catalog = normalizeReviewCatalog({
        version: 1,
        custom_review_types: [{
            id: 'architecture-boundary',
            display_label: 'Architecture boundary review',
            enabled_by_default: false,
            skill_id: 'architecture-review',
            trigger: { mode: 'manual', signal_ids: [] },
            coverage_category_ids: ['maintainability'],
            reviewer_role: {
                role_id: 'architecture-reviewer',
                focus_tags: ['maintainability']
            }
        }]
    }, { knownSkillIds: ['architecture-review'] });
    const capabilities = Object.fromEntries(
        catalog.review_types.map((definition) => [definition.id, true])
    ) as ReviewCapabilitiesConfigMap;
    const profilePolicy = resolveProfileReviewCatalogPolicy(
        'balanced',
        { 'architecture-boundary': profileState },
        capabilities,
        catalog
    );
    const snapshot = buildEffectiveReviewSnapshot({
        catalog,
        profilePolicy,
        profileSnapshotSha256: 'a'.repeat(64),
        legacyRequiredReviews: {},
        scopeCategory: 'code',
        taskIntent: 'Inspect an architecture boundary',
        changedFiles: ['src/architecture.ts'],
        taskTriggers: {},
        zeroDiffBaselineOnly: false
    });
    return {
        task_id: 'T-729-4A-fixture',
        scope_category: 'code',
        changed_files: ['src/architecture.ts'],
        required_reviews: snapshot.required_reviews,
        effective_review_snapshot: snapshot,
        budget_forecast: { token_economy_active_for_depth: true },
        risk_aware_depth: { compression: { scoped_diffs: true } }
    };
}

describe('catalog-backed review context lane binding', () => {
    it('binds a capability-enabled task-required API lane while preserving disabled profile defaults', () => {
        const catalog = normalizeReviewCatalog({ version: 1, custom_review_types: [] });
        const capabilities = Object.fromEntries(
            catalog.review_types.map(definition => [definition.id, true])
        ) as ReviewCapabilitiesConfigMap;
        const profilePolicy = resolveProfileReviewCatalogPolicy('fast', { api: false }, capabilities, catalog);
        const options = {
            catalog, profilePolicy, profileSnapshotSha256: 'a'.repeat(64),
            legacyRequiredReviews: { api: true }, taskRequiredReviewIds: ['api'],
            scopeCategory: 'code', taskIntent: 'Inspect diagnostics', changedFiles: ['src/diagnostics.ts'], taskTriggers: {}
        };
        const snapshot = buildEffectiveReviewSnapshot(options);
        const preflight = { required_reviews: snapshot.required_reviews, effective_review_snapshot: snapshot };
        const binding = resolveReviewContextLaneBinding(preflight, 'api');
        assert.equal(binding.selection, 'required');
        assert.equal(binding.built_in, true);
        assert.equal(binding.effective_review_snapshot_sha256, snapshot.snapshot_sha256);
        assert.deepEqual(binding.skill_ids, ['api-review', 'api-contract-review']);
        assert.equal(snapshot.lanes.find(lane => lane.id === 'api')?.profile.active, false);
        const undeclared = buildEffectiveReviewSnapshot({ ...options, taskRequiredReviewIds: [] });
        assert.throws(() => resolveReviewContextLaneBinding({
            required_reviews: { ...undeclared.required_reviews, api: true }, effective_review_snapshot: undeclared
        }, 'api'), /inactive in the immutable effective review snapshot/);
        assert.throws(() => resolveReviewContextLaneBinding({
            required_reviews: { ...snapshot.required_reviews, api: false }, effective_review_snapshot: snapshot
        }, 'api'), /does not match immutable lane selection/);
        const forged = JSON.parse(JSON.stringify(snapshot));
        forged.lanes.find((lane: { id: string }) => lane.id === 'api').profile.capability_enabled = false;
        assert.throws(() => resolveReviewContextLaneBinding({
            required_reviews: snapshot.required_reviews, effective_review_snapshot: forged
        }, 'api'), /capability-disabled/);
    });

    it('binds a selected custom lane to snapshot hashes, role, canonical verdict, coverage, and scoped diff', () => {
        const preflight = buildCustomPreflight(true);
        const binding = resolveReviewContextLaneBinding(preflight, 'architecture-boundary');

        assert.equal(binding.review_type, 'architecture-boundary');
        assert.equal(binding.selection, 'required');
        assert.equal(binding.built_in, false);
        assert.deepEqual(binding.skill_ids, ['architecture-review']);
        assert.deepEqual(binding.coverage_category_ids, ['maintainability']);
        assert.deepEqual(binding.reviewer_role, {
            role_id: 'architecture-reviewer',
            focus_tags: ['maintainability']
        });
        assert.deepEqual(binding.verdict_tokens, {
            pass: 'ARCHITECTURE BOUNDARY REVIEW PASSED',
            fail: 'ARCHITECTURE BOUNDARY REVIEW FAILED'
        });
        assert.match(binding.binding_sha256, /^[a-f0-9]{64}$/u);
        assert.equal(isCustomReviewLaneInSnapshot(preflight, 'architecture-boundary'), true);
        assert.deepEqual(
            resolveReviewCoverageCategoryIdsFromPreflight(preflight, 'architecture-boundary'),
            ['maintainability']
        );
        assert.equal(
            buildReviewContextPreflightDiffExpectations(preflight, 'architecture-boundary').expectedScopedDiff,
            true
        );

        const coverage = buildReviewCoverageContract({
            reviewType: 'architecture-boundary',
            changedFiles: ['src/architecture.ts'],
            categoryIds: binding.coverage_category_ids
        });
        assert.ok(coverage.obligations.some((entry) => entry.id === 'CATEGORY-MAINTAINABILITY'));
        assert.equal(coverage.obligations.some((entry) => entry.id === 'CATEGORY-ASSIGNED-REVIEW-CONTRACT'), false);

        const optionalPreflight = buildCustomPreflight('auto');
        const optionalBinding = resolveReviewContextLaneBinding(optionalPreflight, 'architecture-boundary');
        const optionalDiffExpectations = buildReviewContextPreflightDiffExpectations(
            optionalPreflight,
            'architecture-boundary'
        );
        assert.equal(optionalBinding.selection, 'optional');
        assert.equal((optionalPreflight.required_reviews as Record<string, boolean>)['architecture-boundary'], false);
        assert.equal(optionalDiffExpectations.expectedRequiredReview, true);
        assert.equal(optionalDiffExpectations.expectedScopedDiff, true);

        const authoritativeCoverage = buildAuthoritativeReviewCoverageContract({
            reviewType: 'architecture-boundary',
            preflight: optionalPreflight,
            repoRoot: process.cwd()
        });
        assert.deepEqual(resolveAuthoritativeReviewCoverageScope({
            reviewType: 'architecture-boundary',
            preflight: optionalPreflight,
            repoRoot: process.cwd()
        }), {
            changedFiles: ['src/architecture.ts'],
            categoryIds: ['maintainability']
        });
        assert.ok(authoritativeCoverage.contract.obligations.some(
            (entry) => entry.id === 'CATEGORY-MAINTAINABILITY'
        ));
        assert.equal(buildFocusedRecoveryCoverageContractSha256({
            reviewType: 'architecture-boundary',
            preflight: optionalPreflight,
            repoRoot: process.cwd()
        }), authoritativeCoverage.contract.contract_sha256);
        assert.deepEqual(getReusedReviewCoverageContractViolations({
            reviewType: 'architecture-boundary',
            preflight: optionalPreflight,
            repoRoot: process.cwd(),
            coverageContract: authoritativeCoverage.contract
        }), []);
    });

    it('rejects unknown, inactive, malformed-category, and missing-skill lanes before launch', () => {
        const activePreflight = buildCustomPreflight(true);
        assert.throws(
            () => resolveReviewContextLaneBinding(activePreflight, 'live-config-only'),
            /unknown to the immutable effective review snapshot/u
        );

        const inactivePreflight = buildCustomPreflight(false);
        assert.throws(
            () => resolveReviewContextLaneBinding(inactivePreflight, 'architecture-boundary'),
            /is inactive in the immutable effective review snapshot/u
        );

        const malformedPreflight = JSON.parse(JSON.stringify(activePreflight)) as Record<string, unknown>;
        const malformedSnapshot = malformedPreflight.effective_review_snapshot as {
            lanes: Array<{ id: string; definition: { coverage_category_ids: string[] } }>;
        };
        const malformedLane = malformedSnapshot.lanes.find((lane) => lane.id === 'architecture-boundary');
        assert.ok(malformedLane);
        malformedLane.definition.coverage_category_ids = ['raw-prompt-category'];
        assert.throws(
            () => resolveReviewContextLaneBinding(malformedPreflight, 'architecture-boundary'),
            /unknown coverage category 'raw-prompt-category'/u
        );

        const malformedLanesPreflight = JSON.parse(JSON.stringify(activePreflight)) as Record<string, unknown>;
        (malformedLanesPreflight.effective_review_snapshot as Record<string, unknown>).lanes = {};
        assert.throws(
            () => resolveReviewContextLaneBinding(malformedLanesPreflight, 'architecture-boundary'),
            /Effective review snapshot lanes must be an array/u
        );

        const malformedReasonsPreflight = JSON.parse(JSON.stringify(inactivePreflight)) as Record<string, unknown>;
        const malformedReasonsSnapshot = malformedReasonsPreflight.effective_review_snapshot as {
            lanes: Array<{ id: string; inactive_reasons: unknown }>;
        };
        const malformedReasonsLane = malformedReasonsSnapshot.lanes.find(
            (lane) => lane.id === 'architecture-boundary'
        );
        assert.ok(malformedReasonsLane);
        malformedReasonsLane.inactive_reasons = 'raw reason';
        assert.throws(
            () => resolveReviewContextLaneBinding(malformedReasonsPreflight, 'architecture-boundary'),
            /reasons must be string arrays/u
        );

        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-context-lane-skill-'));
        try {
            assert.throws(
                () => resolveCatalogReviewSkillBinding(['architecture-review'], repoRoot),
                /missing an entrypoint/u
            );
            const skillRoot = path.join(
                repoRoot,
                'garda-agent-orchestrator',
                'live',
                'skills',
                'architecture-review'
            );
            fs.mkdirSync(skillRoot, { recursive: true });
            fs.writeFileSync(path.join(skillRoot, 'SKILL.md'), '# Architecture review\n', 'utf8');
            const selectedSkill = resolveCatalogReviewSkillBinding(['architecture-review'], repoRoot);
            assert.equal(selectedSkill.skill_id, 'architecture-review');
            assert.equal(selectedSkill.skill_entrypoint_exists, true);

            const escapedSkillRoot = path.join(repoRoot, 'outside-review');
            fs.mkdirSync(escapedSkillRoot, { recursive: true });
            fs.writeFileSync(path.join(escapedSkillRoot, 'SKILL.md'), '# Escaped review\n', 'utf8');
            assert.throws(
                () => resolveCatalogReviewSkillBinding(['../../../outside-review'], repoRoot),
                /single catalog path component without traversal/u
            );
            assert.throws(
                () => resolveCatalogReviewSkillBinding(['architecture-review', '..\\outside-review'], repoRoot),
                /single catalog path component without traversal/u
            );
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }

        const linkedRepoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-context-linked-root-'));
        const externalSkillsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-context-external-skills-'));
        try {
            const liveRoot = path.join(linkedRepoRoot, 'garda-agent-orchestrator', 'live');
            const externalSkillRoot = path.join(externalSkillsRoot, 'architecture-review');
            fs.mkdirSync(liveRoot, { recursive: true });
            fs.mkdirSync(externalSkillRoot, { recursive: true });
            fs.writeFileSync(path.join(externalSkillRoot, 'SKILL.md'), '# External review\n', 'utf8');
            fs.symlinkSync(
                externalSkillsRoot,
                path.join(liveRoot, 'skills'),
                process.platform === 'win32' ? 'junction' : 'dir'
            );
            assert.throws(
                () => resolveCatalogReviewSkillBinding(['architecture-review'], linkedRepoRoot),
                /ReviewSkillCatalogRoot must resolve inside repo root/u
            );
        } finally {
            fs.rmSync(linkedRepoRoot, { recursive: true, force: true });
            fs.rmSync(externalSkillsRoot, { recursive: true, force: true });
        }

        const linkedSkillRepoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-context-linked-skill-'));
        const externalSkillRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-context-external-skill-'));
        try {
            const skillsRoot = path.join(
                linkedSkillRepoRoot,
                'garda-agent-orchestrator',
                'live',
                'skills'
            );
            fs.mkdirSync(skillsRoot, { recursive: true });
            fs.writeFileSync(path.join(externalSkillRoot, 'SKILL.md'), '# External review\n', 'utf8');
            fs.symlinkSync(
                externalSkillRoot,
                path.join(skillsRoot, 'architecture-review'),
                process.platform === 'win32' ? 'junction' : 'dir'
            );
            assert.throws(
                () => resolveCatalogReviewSkillBinding(['architecture-review'], linkedSkillRepoRoot),
                /ReviewSkillPath must resolve inside the catalog skills root/u
            );
        } finally {
            fs.rmSync(linkedSkillRepoRoot, { recursive: true, force: true });
            fs.rmSync(externalSkillRoot, { recursive: true, force: true });
        }
    });

    it('rejects replaced custom skill path and hash while propagating the valid custom lane lifecycle', async () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-custom-review-context-build-'));
        const orchestratorRoot = path.join(repoRoot, 'garda-agent-orchestrator');
        const reviewsRoot = path.join(orchestratorRoot, 'runtime', 'reviews');
        const tokenConfigPath = path.join(orchestratorRoot, 'live', 'config', 'token-economy.json');
        const pathsConfigPath = path.join(orchestratorRoot, 'live', 'config', 'paths.json');
        const sourcePath = path.join(repoRoot, 'src', 'architecture.ts');
        try {
            fs.mkdirSync(reviewsRoot, { recursive: true });
            fs.mkdirSync(path.dirname(tokenConfigPath), { recursive: true });
            fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
            fs.writeFileSync(tokenConfigPath, JSON.stringify({ enabled: false }, null, 2), 'utf8');
            fs.writeFileSync(pathsConfigPath, JSON.stringify({
                triggers: { 'architecture-boundary': ['^src/architecture\\.ts$'] }
            }, null, 2), 'utf8');
            fs.writeFileSync(sourcePath, 'export const architecture = 1;\n', 'utf8');
            runGit(repoRoot, ['init']);
            runGit(repoRoot, ['config', 'user.name', 'Garda Tests']);
            runGit(repoRoot, ['config', 'user.email', 'garda-tests@example.com']);
            runGit(repoRoot, ['add', '.']);
            runGit(repoRoot, ['commit', '-m', 'baseline']);
            fs.writeFileSync(sourcePath, 'export const architecture = 2;\n', 'utf8');
            writeTaskModeArtifactFixture(repoRoot, 'T-729-4A-fixture', {
                provider: 'Codex',
                canonicalSourceOfTruth: 'Codex',
                executionProviderSource: 'explicit_provider',
                runtimeIdentityStatus: 'resolved'
            });

            const activePreflight = buildCustomPreflight(true);
            const activePreflightPath = path.join(reviewsRoot, 'T-729-4A-fixture-preflight.json');
            fs.writeFileSync(activePreflightPath, JSON.stringify(activePreflight, null, 2), 'utf8');
            const scopedDiffMetadataPath = path.join(
                reviewsRoot,
                'T-729-4A-fixture-architecture-boundary-scoped.json'
            );
            buildScopedDiff({
                reviewType: 'architecture-boundary',
                preflightPath: activePreflightPath,
                pathsConfigPath,
                outputPath: path.join(
                    reviewsRoot,
                    'T-729-4A-fixture-architecture-boundary-scoped.diff'
                ),
                metadataPath: scopedDiffMetadataPath,
                repoRoot
            });
            const outputPath = path.join(
                reviewsRoot,
                'T-729-4A-fixture-architecture-boundary-review-context.json'
            );
            const result = buildReviewContext({
                reviewType: 'architecture-boundary',
                depth: 3,
                preflightPath: activePreflightPath,
                preflightPayload: activePreflight,
                tokenEconomyConfigPath: tokenConfigPath,
                scopedDiffMetadataPath,
                outputPath,
                repoRoot
            });

            const reviewLane = result.review_lane;
            assert.ok(reviewLane);
            assert.equal(reviewLane.review_type, 'architecture-boundary');
            assert.equal(reviewLane.reviewer_role.role_id, 'architecture-reviewer');
            assert.ok(result.coverage_contract.obligations.some(
                (entry: { id: string }) => entry.id === 'CATEGORY-MAINTAINABILITY'
            ));
            assert.equal(result.rule_context.selected_skill.skill_id, 'architecture-review');
            assert.match(
                fs.readFileSync(result.reviewer_handoff.role_prompt.artifact_path, 'utf8'),
                /Catalog reviewer role id: architecture-reviewer/u
            );
            const manifest = JSON.parse(fs.readFileSync(
                result.reviewer_handoff.evidence_manifest.artifact_path,
                'utf8'
            )) as Record<string, unknown>;
            assert.deepEqual(manifest.review_lane, reviewLane);

            const forgedContext = JSON.parse(JSON.stringify(result)) as Record<string, unknown>;
            const forgedRuleContext = forgedContext.rule_context as {
                selected_skill: Record<string, unknown>;
            };
            const forgedHandoff = forgedContext.reviewer_handoff as {
                role_prompt: { selected_skill: Record<string, unknown> };
            };
            for (const selectedSkill of [
                forgedRuleContext.selected_skill,
                forgedHandoff.role_prompt.selected_skill
            ]) {
                selectedSkill.skill_id = 'unrelated-review';
                selectedSkill.candidate_skill_ids = ['unrelated-review'];
            }
            const forgedViolations = getReviewContextContractViolations({
                contextPath: outputPath,
                reviewContext: forgedContext,
                expectedReviewType: 'architecture-boundary',
                expectedPreflightPayload: activePreflight,
                repoRoot
            });
            assert.ok(forgedViolations.some(
                (violation) => violation.includes('custom selected_skill is not bound')
            ));
            assert.ok(forgedViolations.some(
                (violation) => violation.includes('custom selected_skill candidates do not match')
            ));

            const forgedArtifactBinding = JSON.parse(JSON.stringify(result)) as Record<string, unknown>;
            const forgedArtifactRuleContext = forgedArtifactBinding.rule_context as {
                selected_skill: Record<string, unknown>;
            };
            const forgedArtifactHandoff = forgedArtifactBinding.reviewer_handoff as {
                role_prompt: { selected_skill: Record<string, unknown> };
            };
            for (const selectedSkill of [
                forgedArtifactRuleContext.selected_skill,
                forgedArtifactHandoff.role_prompt.selected_skill
            ]) {
                selectedSkill.skill_path = path.join(repoRoot, 'forged', 'SKILL.md');
                selectedSkill.skill_directory_path = path.join(repoRoot, 'forged');
                selectedSkill.skill_sha256 = 'b'.repeat(64);
            }
            const forgedArtifactViolations = getReviewContextContractViolations({
                contextPath: outputPath,
                reviewContext: forgedArtifactBinding,
                expectedReviewType: 'architecture-boundary',
                expectedPreflightPayload: activePreflight,
                repoRoot
            });
            assert.ok(forgedArtifactViolations.some(
                (violation) => violation.includes('custom selected_skill path or content hash does not match')
            ));

            const selectedSkillPath = result.rule_context.selected_skill.skill_path;
            const selectedSkillContent = fs.readFileSync(selectedSkillPath, 'utf8');
            try {
                fs.writeFileSync(selectedSkillPath, `${selectedSkillContent}\nChanged after context construction.\n`, 'utf8');
                const staleSkillContentViolations = getReviewContextContractViolations({
                    contextPath: outputPath,
                    reviewContext: result as unknown as Record<string, unknown>,
                    expectedReviewType: 'architecture-boundary',
                    expectedPreflightPayload: activePreflight,
                    repoRoot
                });
                assert.ok(staleSkillContentViolations.some(
                    (violation) => violation.includes('custom selected_skill path or content hash does not match')
                ));
            } finally {
                fs.writeFileSync(selectedSkillPath, selectedSkillContent, 'utf8');
            }

            await emitGeneratedReviewContextPreparationTelemetry({
                repoRoot,
                taskId: 'T-729-4A-fixture',
                reviewType: 'architecture-boundary',
                depth: 3,
                preflightPath: activePreflightPath,
                outputPath,
                ruleContextArtifactPath: result.rule_context.artifact_path,
                selectedSkill: result.rule_context.selected_skill
            });
            const telemetryEvents = fs.readFileSync(
                path.join(orchestratorRoot, 'runtime', 'task-events', 'T-729-4A-fixture.jsonl'),
                'utf8'
            ).trim().split(/\r?\n/u).map((line) => JSON.parse(line) as Record<string, unknown>);
            assert.ok(telemetryEvents.some((event) => (
                event.event_type === 'SKILL_SELECTED'
                && (event.details as Record<string, unknown>)?.skill_id === 'architecture-review'
            )));
            assert.ok(telemetryEvents.some((event) => (
                event.event_type === 'SKILL_REFERENCE_LOADED'
                && (event.details as Record<string, unknown>)?.trigger_reason === 'review_skill'
                && (event.details as Record<string, unknown>)?.skill_id === 'architecture-review'
            )));

            const auditCoverage = buildAuthoritativeReviewCoverageContract({
                reviewType: 'architecture-boundary',
                preflight: activePreflight,
                repoRoot
            }).contract;
            const contextSha256 = fileSha256(outputPath);
            const preflightSha256 = fileSha256(activePreflightPath);
            assert.ok(contextSha256);
            assert.ok(preflightSha256);
            const reviewTreeStateSha256 = result.tree_state.tree_state_sha256;
            const reviewExecution = result.review_execution as ReviewRemediationReviewContract;
            const reviewArtifactPath = path.join(
                reviewsRoot,
                'T-729-4A-fixture-architecture-boundary.md'
            );
            const reviewReport = {
                schema_version: 2,
                task_id: 'T-729-4A-fixture',
                review_type: 'architecture-boundary',
                review_context_sha256: contextSha256,
                tree_state_sha256: reviewTreeStateSha256,
                validation_notes: [{
                    id: 'N-001',
                    topic: 'custom review lane lifecycle',
                    note: 'Validated custom review lane coverage, immutable skill binding, and audit propagation.',
                    evidence: [{
                        location: 'src/architecture.ts:1',
                        observation: 'Inspected the architecture boundary source selected by the custom lane.'
                    }]
                }],
                coverage_ledger: {
                    coverage_contract_sha256: auditCoverage.contract_sha256,
                    entries: auditCoverage.obligations.map((obligation) => ({
                        obligation_id: obligation.id,
                        evidence: [{
                            location: 'src/architecture.ts:1',
                            observation: `Validated custom review obligation ${obligation.id}.`
                        }],
                        finding_ids: []
                    }))
                },
                review_execution: {
                    mode: reviewExecution.mode,
                    contract_sha256: reviewExecution.contract_sha256,
                    covered_delta_targets: [],
                    inspected_prior_finding_ids: []
                },
                findings: { critical: [], high: [], medium: [], low: [] },
                residual_risks: [],
                reviewer_notes: []
            };
            fs.writeFileSync(reviewArtifactPath, `${JSON.stringify(reviewReport, null, 2)}\n`, 'utf8');
            const reviewArtifactSha256 = fileSha256(reviewArtifactPath);
            assert.ok(reviewArtifactSha256);
            const validation = validateReviewFindingsContract({
                content: fs.readFileSync(reviewArtifactPath, 'utf8'),
                expectedTaskId: 'T-729-4A-fixture',
                expectedReviewType: 'architecture-boundary',
                expectedReviewContextSha256: contextSha256,
                expectedTreeStateSha256: reviewTreeStateSha256,
                coverageContract: auditCoverage,
                expectedReviewExecutionContract: reviewExecution
            });
            assert.equal(validation.valid, true, validation.violations.join('\n'));
            const validationArtifactPath = getReviewFindingsValidationArtifactPath(reviewArtifactPath);
            const scopeSha256 = 'c'.repeat(64);
            const reviewScopeSha256 = 'd'.repeat(64);
            const codeScopeSha256 = 'e'.repeat(64);
            const validationArtifact = buildReviewFindingsValidationArtifact({
                taskId: 'T-729-4A-fixture',
                reviewType: 'architecture-boundary',
                validation,
                reviewOutputSha256: reviewArtifactSha256,
                reviewArtifactPath,
                reviewArtifactSha256,
                reviewContextPath: outputPath,
                reviewContextSha256: contextSha256,
                preflightPath: activePreflightPath,
                preflightSha256,
                scopeSha256,
                reviewScopeSha256,
                codeScopeSha256,
                reviewTreeStateSha256,
                coverageContract: auditCoverage
            });
            fs.writeFileSync(
                validationArtifactPath,
                `${JSON.stringify(validationArtifact, null, 2)}\n`,
                'utf8'
            );
            const validationArtifactSha256 = fileSha256(validationArtifactPath);
            assert.ok(validationArtifactSha256);
            const executionEvidence = resolveReviewContextExecutionEvidenceBindings(
                result as unknown as Record<string, unknown>
            );
            assert.ok(executionEvidence.bindings, executionEvidence.violations.join('\n'));
            const receipt = buildReviewReceipt({
                taskId: 'T-729-4A-fixture',
                reviewType: 'architecture-boundary',
                preflightSha256,
                scopeSha256,
                reviewScopeSha256,
                codeScopeSha256,
                reviewContextSha256: contextSha256,
                reviewTreeStateSha256,
                reviewExecutionMode: executionEvidence.bindings.review_execution_mode,
                reviewExecutionContractSha256:
                    executionEvidence.bindings.review_execution_contract_sha256,
                reviewExecutionFullScopeSha256:
                    executionEvidence.bindings.review_execution_full_scope_sha256,
                reviewExecutionCompleteScopeLineageSha256:
                    executionEvidence.bindings.review_execution_complete_scope_lineage_sha256,
                reviewExecutionFindingReconciliationSha256:
                    executionEvidence.bindings.review_execution_finding_reconciliation_sha256,
                reviewArtifactSha256,
                reviewerExecutionMode: 'delegated_subagent',
                reviewerIdentity: 'agent:architecture-reviewer',
                trustLevel: 'INDEPENDENT_AUDITED'
            }) as unknown as Record<string, unknown>;
            receipt.review_output_sha256 = reviewArtifactSha256;
            receipt.review_coverage = validation.coverage_validation;
            receipt.review_findings_validation = {
                artifact_path: validationArtifactPath.replace(/\\/gu, '/'),
                artifact_sha256: validationArtifactSha256,
                snapshot_path: null,
                snapshot_sha256: null,
                status: validationArtifact.validation_result.status,
                accepted: validationArtifact.validation_result.accepted,
                validation_result_sha256: validationArtifact.validation_result_sha256,
                violation_count: validationArtifact.validation_result.violations.length
            };
            receipt.review_output_contract = {
                coverage_contract_sha256: auditCoverage.contract_sha256,
                validation_artifact_sha256: validationArtifactSha256,
                validation_result_sha256: validationArtifact.validation_result_sha256,
                ...executionEvidence.bindings
            };
            fs.writeFileSync(path.join(
                reviewsRoot,
                'T-729-4A-fixture-architecture-boundary-receipt.json'
            ), `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
            const auditSummary = buildReviewCoverageAuditSummary({
                reviewsRoot,
                taskId: 'T-729-4A-fixture',
                requiredReviews: { 'architecture-boundary': true }
            });
            assert.equal(
                auditSummary.status,
                'COMPLETE',
                JSON.stringify(auditSummary.entries[0]?.violations)
            );
            assert.equal(auditSummary.entries[0]?.contract_sha256, auditCoverage.contract_sha256);

            const inactivePreflight = buildCustomPreflight(false);
            const inactivePath = path.join(reviewsRoot, 'T-729-4A-fixture-inactive-preflight.json');
            fs.writeFileSync(inactivePath, JSON.stringify(inactivePreflight, null, 2), 'utf8');
            assert.throws(() => buildReviewContext({
                reviewType: 'architecture-boundary',
                depth: 3,
                preflightPath: inactivePath,
                preflightPayload: inactivePreflight,
                tokenEconomyConfigPath: tokenConfigPath,
                scopedDiffMetadataPath: '',
                outputPath: path.join(reviewsRoot, 'inactive-review-context.json'),
                repoRoot
            }), /is inactive in the immutable effective review snapshot/u);
            assert.equal(fs.existsSync(path.join(reviewsRoot, 'inactive-review-context.json')), false);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });
});
