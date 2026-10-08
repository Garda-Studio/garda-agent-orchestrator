import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

import {
    buildReviewContextPreflightDiffExpectations,
    getReviewContextContractViolations,
    reviewContextScopedDiffRequired
} from '../../../../src/gates/review-context/review-context-contract';
import { buildReviewContext, getRulePack } from '../../../../src/gates/review-context/build-review-context';
import { normalizeReviewCatalog } from '../../../../src/core/review-catalog';
import type { ReviewCapabilitiesConfigMap } from '../../../../src/core/review-capabilities';
import { resolveProfileReviewCatalogPolicy } from '../../../../src/policy/profile-review-catalog-policy';
import { computeReviewRuleContextReuseHash } from '../../../../src/gates/review-reuse/review-reuse';
import { buildEffectiveReviewSnapshot } from '../../../../src/policy/effective-review-snapshot';
import { assertReviewContextContractOrThrow } from '../../../../src/cli/commands/gate-review-handlers/context/review-context-runtime-validation';
import { assertReviewTreeStateFresh } from '../../../../src/gates/review/review-tree-state';
import {
    resolveReviewerHandoffArtifactBinding,
    resolveReviewerPromptArtifactBinding
} from '../../../../src/gates/review/review-prompt-artifact';
import { runGit, writeTaskModeArtifactFixture } from './build-review-context-fixtures';

const CURRENT_PREFLIGHT_SHA256 = 'a'.repeat(64);
const CURRENT_CHANGED_FILES_SHA256 = 'b'.repeat(64);
const CURRENT_SCOPE_CONTENT_SHA256 = 'c'.repeat(64);
const CURRENT_SCOPE_SHA256 = 'd'.repeat(64);
const CURRENT_OUTPUT_DIFF_SHA256 = 'e'.repeat(64);

interface BuiltInSkillContextFixture {
    repoRoot: string;
    preflight: Record<string, unknown>;
    preflightPath: string;
    contextPath: string;
    reviewContext: ReturnType<typeof buildReviewContext>;
}

function createBuiltInSkillContext(testContext: TestContext, requiredReferences: string[] = []): BuiltInSkillContextFixture {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-built-in-skill-binding-'));
    testContext.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
    const bundleRoot = path.join(repoRoot, 'garda-agent-orchestrator');
    const reviewsRoot = path.join(bundleRoot, 'runtime', 'reviews');
    const write = (filePath: string, content: string): void => {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, content, 'utf8');
    };
    fs.mkdirSync(reviewsRoot, { recursive: true });
    write(path.join(repoRoot, '.gitignore'), 'garda-agent-orchestrator/\n');
    write(path.join(repoRoot, 'src', 'app.ts'), 'export const value = 1;\n');
    runGit(repoRoot, ['init']);
    runGit(repoRoot, ['config', 'user.name', 'Garda Tests']);
    runGit(repoRoot, ['config', 'user.email', 'garda-tests@example.com']);
    runGit(repoRoot, ['add', '.']);
    runGit(repoRoot, ['commit', '-m', 'baseline']);
    write(path.join(repoRoot, 'src', 'app.ts'), 'export const value = 2;\n');

    const catalog = normalizeReviewCatalog({ version: 1, custom_review_types: [] });
    const capabilities = Object.fromEntries(
        catalog.review_types.map((definition) => [definition.id, true])
    ) as ReviewCapabilitiesConfigMap;
    const profilePolicy = resolveProfileReviewCatalogPolicy('balanced', { api: true }, capabilities, catalog);
    const snapshot = buildEffectiveReviewSnapshot({
        catalog, profilePolicy, profileSnapshotSha256: CURRENT_PREFLIGHT_SHA256,
        legacyRequiredReviews: { api: true }, scopeCategory: 'code',
        taskIntent: 'Inspect built-in API skill binding', changedFiles: ['src/app.ts'],
        taskTriggers: {}, zeroDiffBaselineOnly: false
    });
    const preflight: Record<string, unknown> = {
        task_id: 'T-153-1-fixture', detection_source: 'explicit_changed_files',
        scope_category: 'code', changed_files: ['src/app.ts'], triggers: {},
        required_reviews: snapshot.required_reviews, effective_review_snapshot: snapshot,
        review_coverage_contract_required: true
    };
    const preflightPath = path.join(reviewsRoot, 'T-153-1-fixture-preflight.json');
    write(preflightPath, JSON.stringify(preflight, null, 2));
    const tokenEconomyConfigPath = path.join(bundleRoot, 'live', 'config', 'token-economy.json');
    write(tokenEconomyConfigPath, JSON.stringify({ enabled: false }));
    for (const rule of getRulePack('api').full) {
        write(path.join(bundleRoot, 'live', 'docs', 'agent-rules', rule), `# ${rule}\n`);
    }
    for (const skillId of snapshot.lanes.find((lane) => lane.id === 'api')!.definition.skill_ids) {
        write(path.join(bundleRoot, 'live', 'skills', skillId, 'SKILL.md'), `# ${skillId}\nFixture skill.\n`);
    }
    if (requiredReferences.length > 0) {
        const skillId = snapshot.lanes.find((lane) => lane.id === 'api')!.definition.skill_ids[0];
        const skillRoot = path.join(bundleRoot, 'live', 'skills', skillId);
        write(path.join(skillRoot, 'skill.json'), JSON.stringify({ references: requiredReferences }));
        for (const name of requiredReferences) write(path.join(skillRoot, 'references', name), `Lens ${name}.\n`);
    }
    writeTaskModeArtifactFixture(repoRoot, 'T-153-1-fixture', {
        provider: 'Codex', canonicalSourceOfTruth: 'Codex',
        executionProviderSource: 'explicit_provider', runtimeIdentityStatus: 'resolved',
        reviewerSubagentLaunchStatus: 'launchable'
    });
    const contextPath = path.join(reviewsRoot, 'T-153-1-fixture-api-review-context.json');
    const reviewContext = buildReviewContext({
        reviewType: 'api', depth: 2, preflightPath, preflightPayload: preflight,
        tokenEconomyConfigPath, scopedDiffMetadataPath: '', outputPath: contextPath, repoRoot
    });
    return { repoRoot, preflight, preflightPath, contextPath, reviewContext };
}

function currentSkillViolations(fixture: BuiltInSkillContextFixture): string[] {
    return getReviewContextContractViolations({
        contextPath: fixture.contextPath, reviewContext: fixture.reviewContext,
        expectedTaskId: 'T-153-1-fixture', expectedReviewType: 'api',
        expectedPreflightPath: fixture.preflightPath,
        expectedPreflightSha256: sha256Text(fs.readFileSync(fixture.preflightPath, 'utf8')),
        expectedPreflightPayload: fixture.preflight, repoRoot: fixture.repoRoot,
        ...buildReviewContextPreflightDiffExpectations(fixture.preflight, 'api')
    });
}

test('built-in handoff locates required lens inputs and binds reference-only reuse drift', (testContext) => {
    const fixture = createBuiltInSkillContext(testContext, ['z.md', 'a.md']);
    assert.deepEqual(currentSkillViolations(fixture), []);
    const selected = fixture.reviewContext.rule_context.selected_skill;
    const binding = (selected as unknown as { reference_binding: {
        required_references: Array<{ reference_path: string; reference_sha256: string; reference_bytes: number }>
    } }).reference_binding;
    assert.ok(binding, 'Required lens inputs must be bound without changing the generated schema');
    const role = fs.readFileSync(fixture.reviewContext.reviewer_handoff.role_prompt.artifact_path, 'utf8');
    assert.ok(role.includes(`SelectedSkillPath: ${selected.skill_path}`));
    const firstReference = binding.required_references[0];
    assert.ok(role.includes(`RequiredSkillReferencePath: ${firstReference.reference_path}`));
    assert.ok(role.includes(firstReference.reference_sha256));
    assert.ok(role.indexOf(binding.required_references[0].reference_path) < role.indexOf(binding.required_references[1].reference_path));
    const originalHash = computeReviewRuleContextReuseHash(fixture.reviewContext);
    const changedContext = JSON.parse(JSON.stringify(fixture.reviewContext)) as typeof fixture.reviewContext;
    const changedBinding = (changedContext.rule_context.selected_skill as unknown as { reference_binding: typeof binding }).reference_binding;
    changedBinding.required_references[0].reference_sha256 = '9'.repeat(64);
    assert.notEqual(computeReviewRuleContextReuseHash(changedContext), originalHash,
        'Reference inputs must affect reuse even when role artifacts and entrypoint hashes are unchanged');
    assert.equal(fixture.reviewContext.schema_version, 4);
});

test('built-in reference content drift is rejected by actual current launch and receipt admission', (testContext) => {
    const fixture = createBuiltInSkillContext(testContext, ['checklist.md']);
    const referencePath = path.join(fixture.reviewContext.rule_context.selected_skill.skill_directory_path, 'references', 'checklist.md');
    const contextBytes = fs.readFileSync(fixture.contextPath);
    fs.appendFileSync(referencePath, 'New mandatory lens input.\n');
    assert.deepEqual(fs.readFileSync(fixture.contextPath), contextBytes);
    for (const gateName of ['prepare-reviewer-launch', 'record-review-receipt']) {
        assertReviewTreeStateFresh({ ...fixture, gateName });
        resolveReviewerPromptArtifactBinding({ ...fixture, gateName });
        assert.throws(() => assertReviewContextContractOrThrow({
            ...fixture, taskId: 'T-153-1-fixture', reviewType: 'api',
            preflightSha256: sha256Text(fs.readFileSync(fixture.preflightPath, 'utf8')),
            preflightPayload: fixture.preflight, requireStrictBindingMetadata: true
        }), /selected_skill path or content hash does not match/u, gateName);
    }
});

test('built-in current admission rejects required-reference declaration removal with an unchanged entrypoint', (testContext) => {
    const fixture = createBuiltInSkillContext(testContext, ['checklist.md']);
    const selected = fixture.reviewContext.rule_context.selected_skill;
    const entrypointBytes = fs.readFileSync(selected.skill_path);
    fs.writeFileSync(path.join(selected.skill_directory_path, 'skill.json'), JSON.stringify({ references: [] }));
    assert.deepEqual(fs.readFileSync(selected.skill_path), entrypointBytes);
    assert.throws(() => assertReviewContextContractOrThrow({
        ...fixture, taskId: 'T-153-1-fixture', reviewType: 'api',
        preflightSha256: sha256Text(fs.readFileSync(fixture.preflightPath, 'utf8')),
        preflightPayload: fixture.preflight, requireStrictBindingMetadata: true
    }), /selected_skill path or content hash does not match/u);
});

test('built-in current admission rejects missing and escaped required references without rewriting history', (testContext) => {
    const fixture = createBuiltInSkillContext(testContext, ['checklist.md']);
    const referencePath = path.join(fixture.reviewContext.rule_context.selected_skill.skill_directory_path, 'references', 'checklist.md');
    const originalContext = fs.readFileSync(fixture.contextPath);
    fs.unlinkSync(referencePath);
    assert.throws(() => assertReviewContextContractOrThrow({
        ...fixture, taskId: 'T-153-1-fixture', reviewType: 'api',
        preflightSha256: sha256Text(fs.readFileSync(fixture.preflightPath, 'utf8')),
        preflightPayload: fixture.preflight, requireStrictBindingMetadata: true
    }), /cannot be authenticated/u);
    const outsidePath = path.join(fixture.repoRoot, 'outside-reference.md');
    fs.writeFileSync(outsidePath, 'Foreign required lens.\n');
    fs.symlinkSync(outsidePath, referencePath, 'file');
    assert.throws(() => assertReviewContextContractOrThrow({
        ...fixture, taskId: 'T-153-1-fixture', reviewType: 'api',
        preflightSha256: sha256Text(fs.readFileSync(fixture.preflightPath, 'utf8')),
        preflightPayload: fixture.preflight, requireStrictBindingMetadata: true
    }), /cannot be authenticated/u);
    assert.deepEqual(fs.readFileSync(fixture.contextPath), originalContext);
});

test('built-in skill context rejects entrypoint drift through current launch and receipt guards', (testContext) => {
    const fixture = createBuiltInSkillContext(testContext);
    assert.deepEqual(currentSkillViolations(fixture), []);
    const before = fs.readFileSync(fixture.contextPath);
    const selected = fixture.reviewContext.rule_context.selected_skill;
    fs.appendFileSync(selected.skill_path, 'Changed after context generation.\n');
    assert.deepEqual(fs.readFileSync(fixture.contextPath), before);
    for (const gateName of ['prepare-reviewer-launch', 'record-review-receipt']) {
        // Exercise the real downstream guards; no reviewer or receipt is fabricated.
        assertReviewTreeStateFresh({ ...fixture, gateName });
        resolveReviewerPromptArtifactBinding({ ...fixture, gateName });
        for (const handoffKey of ['role_prompt', 'prompt_template', 'output_template', 'evidence_manifest']) {
            resolveReviewerHandoffArtifactBinding({ ...fixture, gateName, handoffKey, artifactLabel: handoffKey });
        }
    }
    assert.throws(() => assertReviewContextContractOrThrow({
        ...fixture, taskId: 'T-153-1-fixture', reviewType: 'api',
        preflightSha256: sha256Text(fs.readFileSync(fixture.preflightPath, 'utf8')),
        preflightPayload: fixture.preflight, requireStrictBindingMetadata: true
    }), /selected_skill path or content hash does not match/u);
});

test('built-in skill context rejects substituted candidates paths and role mismatch', (testContext) => {
    const fixture = createBuiltInSkillContext(testContext);
    const original = JSON.stringify(fixture.reviewContext);
    const mutations = [
        { field: 'skill_id', value: 'security-review', diagnostic: /not bound to immutable lane skill_ids/u },
        { field: 'candidate_skill_ids', value: ['api-contract-review', 'api-review'], diagnostic: /candidates do not match/u },
        { field: 'skill_path', value: path.join(fixture.repoRoot, '..', 'outside', 'SKILL.md'), diagnostic: /path or content hash does not match/u },
        { field: 'skill_directory_path', value: path.join(fixture.repoRoot, 'forged'), diagnostic: /path or content hash does not match/u },
        { field: 'skill_entrypoint_exists', value: false, diagnostic: /authenticated entrypoint hash/u }
    ];
    for (const mutation of mutations) {
        const reviewContext = JSON.parse(original) as typeof fixture.reviewContext;
        for (const binding of [reviewContext.rule_context.selected_skill, reviewContext.reviewer_handoff.role_prompt.selected_skill]) {
            Object.assign(binding, { [mutation.field]: mutation.value });
        }
        assert.ok(currentSkillViolations({ ...fixture, reviewContext }).some((violation) => mutation.diagnostic.test(violation)), mutation.field);
    }
    const mismatched = JSON.parse(original) as typeof fixture.reviewContext;
    mismatched.reviewer_handoff.role_prompt.selected_skill.skill_sha256 = 'b'.repeat(64);
    assert.ok(currentSkillViolations({ ...fixture, reviewContext: mismatched }).some((violation) => /differs between rule_context/u.test(violation)));
    assert.deepEqual(currentSkillViolations(fixture), []);
});

test('built-in skill context rejects removed entrypoints and candidate fallback drift', (testContext) => {
    const fixture = createBuiltInSkillContext(testContext);
    const selected = fixture.reviewContext.rule_context.selected_skill;
    fs.unlinkSync(selected.skill_path);
    assert.ok(currentSkillViolations(fixture).some((violation) => /path or content hash does not match/u.test(violation)));
    fs.unlinkSync(path.join(fixture.repoRoot, 'garda-agent-orchestrator', 'live', 'skills', 'api-contract-review', 'SKILL.md'));
    assert.ok(currentSkillViolations(fixture).some((violation) => /cannot be authenticated.*missing an entrypoint/u.test(violation)));
});

test('built-in skill context rejects an entrypoint symlink escaping the catalog', (testContext) => {
    const fixture = createBuiltInSkillContext(testContext);
    const skillPath = fixture.reviewContext.rule_context.selected_skill.skill_path;
    const outsidePath = path.join(fixture.repoRoot, 'outside-skill.md');
    fs.writeFileSync(outsidePath, fs.readFileSync(skillPath));
    fs.unlinkSync(skillPath);
    fs.symlinkSync(outsidePath, skillPath, 'file');
    assert.ok(currentSkillViolations(fixture).some((violation) => /cannot be authenticated.*without symlink or junction escape/u.test(violation)));
});

test('built-in skill context rejects current downgrade while preserving legacy diagnostics', (testContext) => {
    const fixture = createBuiltInSkillContext(testContext);
    const historical = JSON.parse(JSON.stringify(fixture.reviewContext)) as typeof fixture.reviewContext;
    historical.schema_version = 3;
    Reflect.deleteProperty(historical.rule_context, 'selected_skill');
    Reflect.deleteProperty(historical.reviewer_handoff.role_prompt, 'selected_skill');
    const legacyPreflight = { ...fixture.preflight, review_coverage_contract_required: false };
    assert.deepEqual(currentSkillViolations({ ...fixture, preflight: legacyPreflight, reviewContext: historical }), []);
    assert.ok(currentSkillViolations({ ...fixture, reviewContext: historical }).some((violation) => /cannot downgrade below schema_version 4/u.test(violation)));
    const withoutRoot = getReviewContextContractViolations({
        contextPath: fixture.contextPath, reviewContext: fixture.reviewContext,
        expectedReviewType: 'api', expectedPreflightPayload: fixture.preflight,
        ...buildReviewContextPreflightDiffExpectations(fixture.preflight, 'api')
    });
    assert.ok(withoutRoot.some((violation) => /cannot be authenticated without the current repo root/u.test(violation)));
});

function sha256Text(value: string): string {
    return createHash('sha256').update(value, 'utf8').digest('hex');
}

function baseContext(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        review_type: 'code',
        task_id: 'T-272',
        preflight_path: 'garda-agent-orchestrator/runtime/reviews/T-272-preflight.json',
        preflight_sha256: CURRENT_PREFLIGHT_SHA256,
        task_scope: {
            changed_files: ['src/app.ts'],
            diff: {
                available: true,
                source: 'git_diff_head_plus_untracked',
                char_count: 120
            }
        },
        scoped_diff: {
            expected: false,
            metadata_path: 'garda-agent-orchestrator/runtime/reviews/T-272-code-scoped.json',
            metadata: null
        },
        ...overrides
    };
}

function validate(reviewContext: Record<string, unknown>, overrides: Record<string, unknown> = {}): string[] {
    return getReviewContextContractViolations({
        contextPath: 'garda-agent-orchestrator/runtime/reviews/T-272-code-review-context.json',
        reviewContext,
        expectedTaskId: 'T-272',
        expectedReviewType: 'code',
        expectedPreflightPath: 'garda-agent-orchestrator/runtime/reviews/T-272-preflight.json',
        expectedPreflightSha256: CURRENT_PREFLIGHT_SHA256,
        requireReviewType: true,
        requireTaskId: true,
        requirePreflightPath: true,
        requirePreflightSha256: true,
        expectedRequiredReview: true,
        expectedChangedFiles: ['src/app.ts'],
        expectedScopeCategory: 'code',
        expectedChangedFilesSha256: CURRENT_CHANGED_FILES_SHA256,
        expectedScopeContentSha256: CURRENT_SCOPE_CONTENT_SHA256,
        expectedScopeSha256: CURRENT_SCOPE_SHA256,
        validateScopedDiffOutputFile: false,
        ...overrides
    });
}

function validScopedMetadata(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        review_type: 'security',
        preflight_path: 'garda-agent-orchestrator/runtime/reviews/T-272-preflight.json',
        preflight_sha256: CURRENT_PREFLIGHT_SHA256,
        changed_files_sha256: CURRENT_CHANGED_FILES_SHA256,
        scope_content_sha256: CURRENT_SCOPE_CONTENT_SHA256,
        scope_sha256: CURRENT_SCOPE_SHA256,
        output_path: 'garda-agent-orchestrator/runtime/reviews/T-272-security-scoped.diff',
        metadata_path: 'garda-agent-orchestrator/runtime/reviews/T-272-security-scoped.json',
        changed_files: ['src/app.ts'],
        output_diff_sha256: CURRENT_OUTPUT_DIFF_SHA256,
        output_diff_line_count: 8,
        ...overrides
    };
}

test('review-context contract rejects required code review contexts without task diff material', () => {
    const violations = validate(baseContext({
        task_scope: {
            changed_files: ['src/app.ts'],
            diff: { available: false, source: 'git_diff_head', char_count: 0 }
        }
    }));

    assert.ok(violations.some((violation) => violation.includes('no task diff material')));
    assert.ok(violations.some((violation) => violation.includes('src/app.ts')));
});

test('review-context contract rejects expected scoped diff metadata when it is missing', () => {
    const violations = validate(baseContext({
        review_type: 'security',
        scoped_diff: {
            expected: true,
            metadata_path: 'garda-agent-orchestrator/runtime/reviews/T-272-security-scoped.json',
            metadata: null
        }
    }), {
        expectedReviewType: 'security'
    });

    assert.ok(violations.some((violation) => violation.includes('expects scoped diff metadata')));
    assert.ok(violations.some((violation) => violation.includes('T-272-security-scoped.json')));
});

test('review-context contract rejects spoofed scoped diff opt-out when preflight requires metadata', () => {
    const violations = validate(baseContext({
        review_type: 'security',
        scoped_diff: {
            expected: false,
            metadata_path: 'garda-agent-orchestrator/runtime/reviews/T-272-security-scoped.json',
            metadata: null
        }
    }), {
        expectedReviewType: 'security',
        expectedScopedDiff: true
    });

    assert.ok(violations.some((violation) => violation.includes('must declare scoped_diff.expected=true')));
    assert.ok(violations.some((violation) => violation.includes('expects scoped diff metadata')));
});

test('review-context contract rejects scoped diff metadata not bound to the current preflight scope', () => {
    const violations = validate(baseContext({
        review_type: 'security',
        scoped_diff: {
            expected: true,
            metadata_path: 'garda-agent-orchestrator/runtime/reviews/T-272-security-scoped.json',
            metadata: validScopedMetadata({
                review_type: 'refactor',
                preflight_path: 'garda-agent-orchestrator/runtime/reviews/OLD-preflight.json',
                output_path: 'garda-agent-orchestrator/runtime/reviews/OLD-security-scoped.diff',
                metadata_path: 'garda-agent-orchestrator/runtime/reviews/OLD-security-scoped.json',
                changed_files: ['src/old.ts']
            })
        }
    }), {
        expectedReviewType: 'security',
        expectedScopedDiff: true
    });

    assert.ok(violations.some((violation) => violation.includes('stale review_type')));
    assert.ok(violations.some((violation) => violation.includes('stale preflight_path')));
    assert.ok(violations.some((violation) => violation.includes('stale metadata_path')));
    assert.ok(violations.some((violation) => violation.includes('changed_files does not match')));
});

test('review-context contract rejects scoped diff metadata from an older preflight with the same files', () => {
    const violations = validate(baseContext({
        review_type: 'security',
        scoped_diff: {
            expected: true,
            metadata_path: 'garda-agent-orchestrator/runtime/reviews/T-272-security-scoped.json',
            metadata: validScopedMetadata({
                preflight_sha256: 'e'.repeat(64),
                changed_files_sha256: 'f'.repeat(64),
                scope_content_sha256: '0'.repeat(64),
                scope_sha256: '1'.repeat(64)
            })
        }
    }), {
        expectedReviewType: 'security',
        expectedScopedDiff: true
    });

    assert.ok(violations.some((violation) => violation.includes('stale preflight_sha256')));
    assert.ok(violations.some((violation) => violation.includes('stale changed_files_sha256')));
    assert.ok(violations.some((violation) => violation.includes('stale scope_content_sha256')));
    assert.ok(violations.some((violation) => violation.includes('stale scope_sha256')));
});

test('review-context contract accepts scoped diff metadata bound to the current preflight scope', () => {
    const violations = validate(baseContext({
        review_type: 'security',
        scoped_diff: {
            expected: true,
            metadata_path: 'garda-agent-orchestrator/runtime/reviews/T-272-security-scoped.json',
            metadata: validScopedMetadata()
        }
    }), {
        expectedReviewType: 'security',
        expectedScopedDiff: true
    });

    assert.deepEqual(violations, []);
});

test('review-context contract rejects scoped diff metadata with stale staged mode', () => {
    const violations = validate(baseContext({
        review_type: 'security',
        scoped_diff: {
            expected: true,
            metadata_path: 'garda-agent-orchestrator/runtime/reviews/T-272-security-scoped.json',
            metadata: validScopedMetadata({
                use_staged: false
            })
        }
    }), {
        expectedReviewType: 'security',
        expectedScopedDiff: true,
        expectedScopedDiffUseStaged: true
    });

    assert.ok(violations.some((violation) => violation.includes('stale use_staged')));
});

test('review-context contract rejects scoped diff output files that no longer match metadata', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-context-contract-output-'));
    const metadataPath = path.join(tempDir, 'T-272-security-scoped.json');
    const outputPath = path.join(tempDir, 'T-272-security-scoped.diff');
    const outputText = 'diff --git a/src/app.ts b/src/app.ts\n+export const value = true;\n';

    try {
        fs.writeFileSync(outputPath, outputText, 'utf8');
        const reviewContext = baseContext({
            review_type: 'security',
            scoped_diff: {
                expected: true,
                metadata_path: metadataPath,
                metadata: validScopedMetadata({
                    metadata_path: metadataPath,
                    output_path: outputPath,
                    output_diff_sha256: sha256Text(outputText)
                })
            }
        });
        assert.deepEqual(validate(reviewContext, {
            expectedReviewType: 'security',
            expectedScopedDiff: true,
            validateScopedDiffOutputFile: true
        }), []);

        fs.writeFileSync(outputPath, 'diff --git a/src/app.ts b/src/app.ts\n+tampered\n', 'utf8');
        const violations = validate(reviewContext, {
            expectedReviewType: 'security',
            expectedScopedDiff: true,
            validateScopedDiffOutputFile: true
        });

        assert.ok(violations.some((violation) => violation.includes('stale output_diff_sha256')));
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('review-context contract rejects scoped diff output files with diff blocks outside preflight scope', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-context-contract-expanded-output-'));
    const metadataPath = path.join(tempDir, 'T-272-security-scoped.json');
    const outputPath = path.join(tempDir, 'T-272-security-scoped.diff');
    const outputText = [
        'diff --git a/src/app.ts b/src/app.ts',
        '--- a/src/app.ts',
        '+++ b/src/app.ts',
        '@@ -1 +1 @@',
        '-export const value = false;',
        '+export const value = true;',
        'diff --git a/src/unrelated.ts b/src/unrelated.ts',
        '--- a/src/unrelated.ts',
        '+++ b/src/unrelated.ts',
        '@@ -1 +1 @@',
        '-export const unrelated = false;',
        '+export const unrelated = true;',
        ''
    ].join('\n');

    try {
        fs.writeFileSync(outputPath, outputText, 'utf8');
        const violations = validate(baseContext({
            review_type: 'security',
            scoped_diff: {
                expected: true,
                metadata_path: metadataPath,
                metadata: validScopedMetadata({
                    metadata_path: metadataPath,
                    output_path: outputPath,
                    output_diff_sha256: sha256Text(outputText)
                })
            }
        }), {
            expectedReviewType: 'security',
            expectedScopedDiff: true,
            validateScopedDiffOutputFile: true
        });

        assert.ok(violations.some((violation) => violation.includes('contains files outside the current preflight scope')));
        assert.ok(violations.some((violation) => violation.includes('src/unrelated.ts')));
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('review-context contract rejects headerless diff content outside preflight scope', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-context-contract-headerless-output-'));
    const metadataPath = path.join(tempDir, 'T-272-security-scoped.json');
    const outputPath = path.join(tempDir, 'T-272-security-scoped.diff');
    const outputText = [
        'diff --git a/src/app.ts b/src/app.ts',
        '--- a/src/app.ts',
        '+++ b/src/app.ts',
        '@@ -1 +1 @@',
        '-export const value = false;',
        '+export const value = true;',
        '--- a/src/unrelated.ts',
        '+++ b/src/unrelated.ts',
        '@@ -1 +1 @@',
        '-export const unrelated = false;',
        '+export const unrelated = true;',
        ''
    ].join('\n');

    try {
        fs.writeFileSync(outputPath, outputText, 'utf8');
        const violations = validate(baseContext({
            review_type: 'security',
            scoped_diff: {
                expected: true,
                metadata_path: metadataPath,
                metadata: validScopedMetadata({
                    metadata_path: metadataPath,
                    output_path: outputPath,
                    output_diff_sha256: sha256Text(outputText)
                })
            }
        }), {
            expectedReviewType: 'security',
            expectedScopedDiff: true,
            validateScopedDiffOutputFile: true
        });

        assert.ok(violations.some((violation) => violation.includes('contains files outside the current preflight scope')));
        assert.ok(violations.some((violation) => violation.includes('src/unrelated.ts')));
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('review-context contract rejects headerless mixed-scope marker pairs after a hunk', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-context-contract-headerless-mixed-output-'));
    const metadataPath = path.join(tempDir, 'T-272-security-scoped.json');
    const outputPath = path.join(tempDir, 'T-272-security-scoped.diff');
    const outputText = [
        'diff --git a/src/app.ts b/src/app.ts',
        '--- a/src/app.ts',
        '+++ b/src/app.ts',
        '@@ -1 +1 @@',
        '-export const value = false;',
        '+export const value = true;',
        '--- a/src/app.ts',
        '+++ b/src/unrelated.ts',
        '@@ -1 +1 @@',
        '-export const unrelated = false;',
        '+export const unrelated = true;',
        ''
    ].join('\n');

    try {
        fs.writeFileSync(outputPath, outputText, 'utf8');
        const violations = validate(baseContext({
            review_type: 'security',
            scoped_diff: {
                expected: true,
                metadata_path: metadataPath,
                metadata: validScopedMetadata({
                    metadata_path: metadataPath,
                    output_path: outputPath,
                    output_diff_sha256: sha256Text(outputText)
                })
            }
        }), {
            expectedReviewType: 'security',
            expectedScopedDiff: true,
            validateScopedDiffOutputFile: true
        });

        assert.ok(violations.some((violation) => violation.includes('contains files outside the current preflight scope')));
        assert.ok(violations.some((violation) => violation.includes('src/unrelated.ts')));
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('review-context contract rejects scoped diff output files with unparseable diff block paths', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-context-contract-unparseable-output-'));
    const metadataPath = path.join(tempDir, 'T-272-security-scoped.json');
    const outputPath = path.join(tempDir, 'T-272-security-scoped.diff');
    const outputText = [
        'diff --git --broken-header',
        '--- a/src/unrelated.ts',
        '+++ b/src/unrelated.ts',
        '@@ -1 +1 @@',
        '-export const unrelated = false;',
        '+export const unrelated = true;',
        ''
    ].join('\n');

    try {
        fs.writeFileSync(outputPath, outputText, 'utf8');
        const violations = validate(baseContext({
            review_type: 'security',
            scoped_diff: {
                expected: true,
                metadata_path: metadataPath,
                metadata: validScopedMetadata({
                    metadata_path: metadataPath,
                    output_path: outputPath,
                    output_diff_sha256: sha256Text(outputText)
                })
            }
        }), {
            expectedReviewType: 'security',
            expectedScopedDiff: true,
            validateScopedDiffOutputFile: true
        });

        assert.ok(violations.some((violation) => violation.includes('unparseable path')));
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('review-context contract accepts custom scoped diff output path when the file hash matches metadata', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-context-contract-custom-output-'));
    const metadataPath = path.join(tempDir, 'metadata', 'T-272-security-scoped.json');
    const outputPath = path.join(tempDir, 'custom-output', 'review.diff');
    const outputText = 'diff --git a/src/app.ts b/src/app.ts\n+export const value = true;\n';

    try {
        fs.mkdirSync(path.dirname(outputPath), { recursive: true });
        fs.writeFileSync(outputPath, outputText, 'utf8');
        const violations = validate(baseContext({
            review_type: 'security',
            scoped_diff: {
                expected: true,
                metadata_path: metadataPath,
                metadata: validScopedMetadata({
                    metadata_path: metadataPath,
                    output_path: outputPath,
                    output_diff_sha256: sha256Text(outputText)
                })
            }
        }), {
            expectedReviewType: 'security',
            expectedScopedDiff: true,
            validateScopedDiffOutputFile: true
        });

        assert.deepEqual(violations, []);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('review-context contract accepts hunk content that looks like diff header markers', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-context-contract-hunk-marker-content-'));
    const metadataPath = path.join(tempDir, 'T-272-security-scoped.json');
    const outputPath = path.join(tempDir, 'T-272-security-scoped.diff');
    const outputText = [
        'diff --git a/src/app.ts b/src/app.ts',
        '--- a/src/app.ts',
        '+++ b/src/app.ts',
        '@@ -1,2 +1,2 @@',
        '-- export const oldMarker = true;',
        '++ export const newMarker = true;',
        ' export const stable = true;',
        ''
    ].join('\n');

    try {
        fs.writeFileSync(outputPath, outputText, 'utf8');
        const violations = validate(baseContext({
            review_type: 'security',
            scoped_diff: {
                expected: true,
                metadata_path: metadataPath,
                metadata: validScopedMetadata({
                    metadata_path: metadataPath,
                    output_path: outputPath,
                    output_diff_sha256: sha256Text(outputText)
                })
            }
        }), {
            expectedReviewType: 'security',
            expectedScopedDiff: true,
            validateScopedDiffOutputFile: true
        });

        assert.deepEqual(violations, []);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('review-context contract accepts rename diffs when the new path is in preflight scope', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-context-contract-rename-output-'));
    const metadataPath = path.join(tempDir, 'T-272-security-scoped.json');
    const outputPath = path.join(tempDir, 'T-272-security-scoped.diff');
    const outputText = [
        'diff --git a/src/old-app.ts b/src/app.ts',
        'similarity index 88%',
        'rename from src/old-app.ts',
        'rename to src/app.ts',
        '--- a/src/old-app.ts',
        '+++ b/src/app.ts',
        '@@ -1 +1 @@',
        '-export const value = false;',
        '+export const value = true;',
        ''
    ].join('\n');

    try {
        fs.writeFileSync(outputPath, outputText, 'utf8');
        const violations = validate(baseContext({
            review_type: 'security',
            task_scope: {
                changed_files: ['src/app.ts'],
                diff: {
                    available: true,
                    source: 'git_diff_head_plus_untracked',
                    char_count: 120
                }
            },
            scoped_diff: {
                expected: true,
                metadata_path: metadataPath,
                metadata: validScopedMetadata({
                    metadata_path: metadataPath,
                    output_path: outputPath,
                    output_diff_sha256: sha256Text(outputText),
                    changed_files: ['src/app.ts']
                })
            }
        }), {
            expectedReviewType: 'security',
            expectedScopedDiff: true,
            expectedChangedFiles: ['src/app.ts'],
            validateScopedDiffOutputFile: true
        });

        assert.deepEqual(violations, []);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('review-context contract rejects expected scoped diff metadata even for docs-only scopes', () => {
    const violations = validate(baseContext({
        review_type: 'security',
        task_scope: {
            changed_files: ['docs/usage.md'],
            diff: { available: false, source: 'none', char_count: 0 }
        },
        scoped_diff: {
            expected: true,
            metadata_path: 'garda-agent-orchestrator/runtime/reviews/T-272-security-scoped.json',
            metadata: null
        }
    }), {
        expectedReviewType: 'security',
        expectedChangedFiles: ['docs/usage.md'],
        expectedScopeCategory: 'docs-only'
    });

    assert.ok(violations.some((violation) => violation.includes('expects scoped diff metadata')));
});

test('review-context contract does not require task diff material for docs-only scopes without scoped diff expectation', () => {
    const violations = validate(baseContext({
        review_type: 'security',
        task_scope: {
            changed_files: ['docs/usage.md'],
            diff: { available: false, source: 'none', char_count: 0 }
        },
        scoped_diff: {
            expected: false,
            metadata_path: 'garda-agent-orchestrator/runtime/reviews/T-272-security-scoped.json',
            metadata: null
        }
    }), {
        expectedReviewType: 'security',
        expectedChangedFiles: ['docs/usage.md'],
        expectedScopeCategory: 'docs-only'
    });

    assert.deepEqual(violations, []);
});

test('preflight diff expectations require scoped diff only for active specialist code reviews', () => {
    const preflight = {
        scope_category: 'code',
        changed_files: ['src/auth.ts'],
        required_reviews: { security: true, code: true },
        budget_forecast: { token_economy_active_for_depth: true },
        risk_aware_depth: { compression: { scoped_diffs: true } }
    };

    assert.equal(buildReviewContextPreflightDiffExpectations(preflight, 'security').expectedScopedDiff, true);
    assert.equal(buildReviewContextPreflightDiffExpectations(preflight, 'code').expectedScopedDiff, false);
    assert.equal(buildReviewContextPreflightDiffExpectations({
        ...preflight,
        detection_source: 'git_staged_only'
    }, 'security').expectedScopedDiffUseStaged, true);
    assert.equal(buildReviewContextPreflightDiffExpectations({
        ...preflight,
        scope_category: 'docs-only',
        changed_files: ['docs/usage.md']
    }, 'security').expectedScopedDiff, false);
    assert.equal(reviewContextScopedDiffRequired({
        reviewType: 'security',
        expectedRequiredReview: true,
        expectedChangedFiles: ['src/auth.ts'],
        expectedScopeCategory: 'code',
        tokenEconomyActiveForDepth: true,
        scopedDiffsEnabled: true
    }), true);
    assert.equal(reviewContextScopedDiffRequired({
        reviewType: 'code',
        expectedRequiredReview: true,
        expectedChangedFiles: ['src/auth.ts'],
        expectedScopeCategory: 'code',
        tokenEconomyActiveForDepth: true,
        scopedDiffsEnabled: true
    }), false);
});
