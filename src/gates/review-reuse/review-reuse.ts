import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DOMAIN_SCOPE_NAMES } from '../../core/domain-scope-contracts';

import { matchAnyRegex } from '../../gate-runtime/text-utils';
import {
    readStagedBlobFingerprints,
    type StagedBlobFingerprints
} from '../../core/staged-index-fingerprints';
import {
    getClassificationConfig,
    isSafeOrdinaryDocumentationPath,
    type ResolvedClassificationConfig
} from '../preflight/classify-change';
import type { ReviewTriggerPolicy } from '../../policy/review-trigger-policy';
import {
    normalizePath,
    stringSha256
} from '../shared/helpers';
import {
    isCloseoutEvidencePath,
    isReviewReuseNeutralCloseoutEvidencePath
} from '../scope/closeout-evidence-paths';
import { getSafeWorktreePathState } from '../workspace/worktree-path-state';

export interface CodeReviewScopeFingerprint {
    all_changed_files: string[];
    non_test_changed_files: string[];
    docs_only_changed_files: string[];
    performance_support_changed_files: string[];
    review_reuse_neutral_config_files: string[];
    review_reuse_neutral_evidence_files: string[];
    review_reuse_neutral_closeout_files: string[];
    missing_non_test_files: string[];
    code_scope_sha256: string | null;
    test_only: boolean;
    docs_only: boolean;
    documentation_review: boolean;
}

export interface ReviewRelevantScopeFingerprint {
    all_changed_files: string[];
    review_relevant_changed_files: string[];
    docs_only_changed_files: string[];
    review_reuse_neutral_config_files: string[];
    review_reuse_neutral_evidence_files: string[];
    review_reuse_neutral_closeout_files: string[];
    missing_review_relevant_files: string[];
    review_scope_sha256: string | null;
    docs_only: boolean;
    documentation_review: boolean;
}

export interface ReviewContextReuseContractBindings {
    coverageContractSha256: string | null;
    ruleContextSha256: string | null;
    reviewExecutionContractSha256: string | null;
    reviewExecutionMode: 'FULL' | 'DELTA' | null;
    reviewExecutionFullScopeSha256: string | null;
}

export function isNonTestReviewScope(reviewType: string): boolean {
    return String(reviewType || '').trim().toLowerCase() !== 'test';
}

function toRecord(value: unknown): Record<string, unknown> {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        return value as Record<string, unknown>;
    }
    return {};
}

export function resolveReviewReuseClassificationConfig(
    preflight: Record<string, unknown>,
    repoRoot: string,
    explicitConfig?: ResolvedClassificationConfig
): ResolvedClassificationConfig {
    if (explicitConfig) {
        return explicitConfig;
    }
    const profilePolicySnapshot = toRecord(preflight.profile_policy_snapshot);
    const reviewTriggerPolicy = toRecord(profilePolicySnapshot.review_trigger_policy);
    return getClassificationConfig(
        repoRoot,
        Object.keys(reviewTriggerPolicy).length > 0
            ? { reviewTriggerPolicy: reviewTriggerPolicy as unknown as ReviewTriggerPolicy }
            : {}
    );
}

function toStringList(value: unknown): string[] {
    if (!Array.isArray(value)) {
        return [];
    }
    return value.map((entry) => String(entry || '').trim()).filter(Boolean);
}

function toSectionList(value: unknown): Array<Record<string, unknown>> {
    if (!Array.isArray(value)) {
        return [];
    }
    return value
        .map((entry) => toRecord(entry))
        .filter((entry) => Object.keys(entry).length > 0)
        .map((entry) => ({
            section: String(entry.section || '').trim() || null,
            reason: String(entry.reason || '').trim() || null,
            details: String(entry.details || '').trim() || null
        }));
}

function toSourceFileSummary(value: unknown): Array<Record<string, unknown>> {
    if (!Array.isArray(value)) {
        return [];
    }
    return value
        .map((entry) => toRecord(entry))
        .filter((entry) => Object.keys(entry).length > 0)
        .map((entry) => ({
            path: String(entry.path || entry.file || '').trim() || null,
            sha256: String(entry.content_sha256 || entry.sha256 || entry.hash || '').trim() || null
        }));
}

function toBoolean(value: unknown): boolean | null {
    if (typeof value === 'boolean') {
        return value;
    }
    const normalized = String(value || '').trim().toLowerCase();
    if (normalized === 'true') {
        return true;
    }
    if (normalized === 'false') {
        return false;
    }
    return null;
}

function toNumberOrNull(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
    }
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}

function toLowerHash(value: unknown): string | null {
    const normalized = String(value || '').trim().toLowerCase();
    return /^[0-9a-f]{64}$/.test(normalized) ? normalized : null;
}

export function resolveDocumentationReviewScopeHash(value: unknown): string | null {
    const domains = toRecord(toRecord(value).domains);
    const documentation = toRecord(domains.docs);
    if (toStringList(documentation.changed_files).length === 0
        || DOMAIN_SCOPE_NAMES.some((domain) => domain !== 'docs' && domain !== 'test'
            && toStringList(toRecord(domains[domain]).changed_files).length > 0)) {
        return null;
    }
    return toLowerHash(documentation.scope_sha256);
}

function resolveTestOnlyReviewScopeHash(value: unknown): string | null {
    const domains = toRecord(toRecord(value).domains);
    const tests = toRecord(domains.test);
    if (toStringList(tests.changed_files).length === 0
        || DOMAIN_SCOPE_NAMES.some((domain) => domain !== 'test' && domain !== 'closeout'
            && toStringList(toRecord(domains[domain]).changed_files).length > 0)) {
        return null;
    }
    return toLowerHash(tests.scope_sha256);
}

export function computeReviewRuleContextReuseHash(
    reviewContext: Record<string, unknown>
): string | null {
    const ruleContext = toRecord(reviewContext.rule_context);
    const reviewerHandoff = toRecord(reviewContext.reviewer_handoff);
    const rolePrompt = toRecord(reviewerHandoff.role_prompt);
    const promptTemplate = toRecord(reviewerHandoff.prompt_template);
    const outputTemplate = toRecord(reviewerHandoff.output_template);
    const reviewLane = toRecord(reviewContext.review_lane);
    const reviewLaneBindingSha256 = toLowerHash(reviewLane.binding_sha256);
    const selectedSkill = Object.keys(toRecord(ruleContext.selected_skill)).length > 0
        ? toRecord(ruleContext.selected_skill)
        : toRecord(rolePrompt.selected_skill);
    const sourceFiles = toSourceFileSummary(ruleContext.source_files);
    const instructionContractSha256 = toLowerHash(ruleContext.instruction_contract_sha256);
    const legacyPromptBindings = instructionContractSha256
        ? {}
        : {
            role_prompt_sha256: toLowerHash(ruleContext.role_prompt_sha256)
                || toLowerHash(rolePrompt.artifact_sha256),
            prompt_template_sha256: toLowerHash(ruleContext.prompt_template_sha256)
                || toLowerHash(promptTemplate.artifact_sha256),
            output_template_sha256: toLowerHash(ruleContext.output_template_sha256)
                || toLowerHash(outputTemplate.artifact_sha256)
        };
    const snapshot = {
        source_file_count: typeof ruleContext.source_file_count === 'number'
            ? ruleContext.source_file_count
            : null,
        strip_examples_applied: ruleContext.strip_examples_applied === true,
        strip_code_blocks_applied: ruleContext.strip_code_blocks_applied === true,
        source_files: sourceFiles,
        selected_skill: {
            skill_id: String(selectedSkill.skill_id || '').trim() || null,
            skill_path: normalizePath(String(selectedSkill.skill_path || '').trim()) || null,
            skill_sha256: toLowerHash(selectedSkill.skill_sha256),
            skill_entrypoint_exists: selectedSkill.skill_entrypoint_exists === true,
            candidate_skill_ids: toStringList(selectedSkill.candidate_skill_ids)
        },
        ...(instructionContractSha256
            ? { instruction_contract_sha256: instructionContractSha256 }
            : legacyPromptBindings),
        ...(reviewLaneBindingSha256 ? { review_lane_binding_sha256: reviewLaneBindingSha256 } : {})
    };
    const hasInstructionBinding = sourceFiles.length > 0
        || !!snapshot.selected_skill.skill_sha256
        || !!instructionContractSha256
        || Object.values(legacyPromptBindings).some(Boolean);
    return hasInstructionBinding ? stringSha256(JSON.stringify(snapshot)) : null;
}

export function resolveReviewContextReuseContractBindings(
    reviewContext: Record<string, unknown>
): ReviewContextReuseContractBindings {
    const coverageContract = toRecord(reviewContext.coverage_contract);
    const reviewExecution = toRecord(reviewContext.review_execution);
    const reviewExecutionMode = String(reviewExecution.mode || '').trim().toUpperCase();
    return {
        coverageContractSha256: toLowerHash(coverageContract.contract_sha256),
        ruleContextSha256: computeReviewRuleContextReuseHash(reviewContext),
        reviewExecutionContractSha256: toLowerHash(reviewExecution.contract_sha256),
        reviewExecutionMode: reviewExecutionMode === 'FULL' || reviewExecutionMode === 'DELTA'
            ? reviewExecutionMode
            : null,
        reviewExecutionFullScopeSha256: toLowerHash(reviewExecution.full_review_scope_sha256)
    };
}

export function resolveReviewReceiptReuseContractBindings(
    receipt: Record<string, unknown>
): ReviewContextReuseContractBindings {
    const reviewCoverage = toRecord(receipt.review_coverage);
    const reviewOutputContract = toRecord(receipt.review_output_contract);
    const findingsReport = toRecord(receipt.review_findings_report);
    const reportReviewExecution = toRecord(findingsReport.review_execution);
    const reviewExecutionMode = String(
        receipt.review_execution_mode
        || reviewOutputContract.review_execution_mode
        || reportReviewExecution.mode
        || ''
    ).trim().toUpperCase();
    return {
        coverageContractSha256: toLowerHash(receipt.review_coverage_contract_sha256)
            || toLowerHash(reviewCoverage.coverage_contract_sha256)
            || toLowerHash(reviewOutputContract.coverage_contract_sha256),
        ruleContextSha256: toLowerHash(receipt.review_rule_context_sha256),
        reviewExecutionContractSha256: toLowerHash(receipt.review_execution_contract_sha256)
            || toLowerHash(reviewOutputContract.review_execution_contract_sha256)
            || toLowerHash(reportReviewExecution.contract_sha256),
        reviewExecutionMode: reviewExecutionMode === 'FULL' || reviewExecutionMode === 'DELTA'
            ? reviewExecutionMode
            : null,
        reviewExecutionFullScopeSha256: toLowerHash(receipt.review_execution_full_scope_sha256)
            || toLowerHash(reviewOutputContract.review_execution_full_scope_sha256)
            || toLowerHash(reportReviewExecution.full_review_scope_sha256)
    };
}

export function getReviewContextReuseContractBindingMismatch(
    historicalBindings: ReviewContextReuseContractBindings,
    currentBindings: ReviewContextReuseContractBindings
): string | null {
    const mismatches: string[] = [];
    if (
        !historicalBindings.coverageContractSha256
        || !currentBindings.coverageContractSha256
        || historicalBindings.coverageContractSha256 !== currentBindings.coverageContractSha256
    ) {
        mismatches.push(
            'reused review coverage contract does not match the current review context: ' +
            `historical coverage_contract_sha256=${historicalBindings.coverageContractSha256 || 'missing'}; ` +
            `current coverage_contract_sha256=${currentBindings.coverageContractSha256 || 'missing'}`
        );
    }
    if (
        !historicalBindings.ruleContextSha256
        || !currentBindings.ruleContextSha256
        || historicalBindings.ruleContextSha256 !== currentBindings.ruleContextSha256
    ) {
        mismatches.push(
            'reused review rule context does not match the current review context: ' +
            `historical rule_context_sha256=${historicalBindings.ruleContextSha256 || 'missing'}; ` +
            `current rule_context_sha256=${currentBindings.ruleContextSha256 || 'missing'}`
        );
    }
    if (!currentBindings.reviewExecutionMode) {
        mismatches.push('current review context is missing a valid FULL/DELTA review execution mode');
    } else if (
        historicalBindings.reviewExecutionMode
        && historicalBindings.reviewExecutionMode !== currentBindings.reviewExecutionMode
    ) {
        mismatches.push(
            'reused review execution mode does not match the current review context: '
            + `historical mode=${historicalBindings.reviewExecutionMode}; `
            + `current mode=${currentBindings.reviewExecutionMode}`
        );
    } else if (
        currentBindings.reviewExecutionMode === 'DELTA'
        && !historicalBindings.reviewExecutionMode
    ) {
        mismatches.push('reused review execution mode is missing for a current DELTA review context');
    }
    if (!currentBindings.reviewExecutionFullScopeSha256) {
        mismatches.push('current review context is missing its review execution full-scope binding');
    } else if (
        currentBindings.reviewExecutionMode === 'DELTA'
        && historicalBindings.reviewExecutionFullScopeSha256
        && historicalBindings.reviewExecutionFullScopeSha256
            !== currentBindings.reviewExecutionFullScopeSha256
    ) {
        mismatches.push(
            'reused review execution full scope does not match the current review context: '
            + `historical full_review_scope_sha256=${historicalBindings.reviewExecutionFullScopeSha256}; `
            + `current full_review_scope_sha256=${currentBindings.reviewExecutionFullScopeSha256}`
        );
    } else if (
        currentBindings.reviewExecutionMode === 'DELTA'
        && !historicalBindings.reviewExecutionFullScopeSha256
    ) {
        mismatches.push('reused review execution full-scope binding is missing for a current DELTA review context');
    }
    if (
        currentBindings.reviewExecutionMode === 'DELTA'
        && (
            !historicalBindings.reviewExecutionContractSha256
            || !currentBindings.reviewExecutionContractSha256
            || historicalBindings.reviewExecutionContractSha256
                !== currentBindings.reviewExecutionContractSha256
        )
    ) {
        mismatches.push(
            'reused DELTA review execution contract does not match the current review context: '
            + `historical contract_sha256=${historicalBindings.reviewExecutionContractSha256 || 'missing'}; `
            + `current contract_sha256=${currentBindings.reviewExecutionContractSha256 || 'missing'}`
        );
    }
    return mismatches.length > 0 ? mismatches.join('; ') : null;
}

function toNormalizedPathList(value: unknown): string[] {
    return toStringList(value)
        .map((entry) => normalizePath(entry))
        .filter(Boolean)
        .sort();
}

function buildScopedDiffReuseMetadata(value: unknown): Record<string, unknown> {
    const metadata = toRecord(value);
    if (Object.keys(metadata).length === 0) {
        return {};
    }
    const hunkFilter = toRecord(metadata.hunk_filter);
    return {
        review_type: String(metadata.review_type || '').trim().toLowerCase() || null,
        changed_files: toNormalizedPathList(metadata.changed_files),
        matched_files: toNormalizedPathList(metadata.matched_files),
        changed_files_sha256: toLowerHash(metadata.changed_files_sha256),
        scope_content_sha256: toLowerHash(metadata.scope_content_sha256),
        use_staged: toBoolean(metadata.use_staged),
        include_untracked: toBoolean(metadata.include_untracked),
        untracked_files: toNormalizedPathList(metadata.untracked_files),
        untracked_diff_truncated: toBoolean(metadata.untracked_diff_truncated),
        full_diff_source: String(metadata.full_diff_source || '').trim() || null,
        fallback_to_full_diff: toBoolean(metadata.fallback_to_full_diff),
        output_diff_sha256: toLowerHash(metadata.output_diff_sha256),
        scoped_diff_line_count: toNumberOrNull(metadata.scoped_diff_line_count),
        output_diff_line_count: toNumberOrNull(metadata.output_diff_line_count),
        hunk_level: toBoolean(metadata.hunk_level),
        hunk_filter: Object.keys(hunkFilter).length > 0
            ? {
                total_file_blocks: toNumberOrNull(hunkFilter.total_file_blocks),
                included_file_blocks: toNumberOrNull(hunkFilter.included_file_blocks),
                total_hunks: toNumberOrNull(hunkFilter.total_hunks),
                included_hunks: toNumberOrNull(hunkFilter.included_hunks),
                hunk_level_filtered: toBoolean(hunkFilter.hunk_level_filtered)
            }
            : null,
        parse_error: String(metadata.parse_error || '').trim() || null
    };
}

function getDetectionSource(preflight: Record<string, unknown>): string {
    return String(preflight.detection_source || '').trim().toLowerCase();
}

function pathStartsWithConfiguredRoot(filePath: string, roots: readonly string[]): boolean {
    const normalizedPath = normalizePath(filePath);
    return roots.some((rootValue) => {
        const root = normalizePath(rootValue).replace(/^\/+/, '').replace(/\/+$/, '');
        return !!root && (normalizedPath === root || normalizedPath.startsWith(`${root}/`));
    });
}

function hasPerformanceSupportDirectory(filePath: string): boolean {
    const segments = normalizePath(filePath).split('/').filter(Boolean);
    const supportDirectories = new Set(['benchmark', 'benchmarks', 'perf', 'performance']);
    const supportParents = new Set(['scripts', 'tools', 'tooling']);
    if (segments.length >= 2 && supportDirectories.has(segments[0])) {
        return true;
    }
    return segments.length >= 3
        && supportParents.has(segments[0])
        && supportDirectories.has(segments[1]);
}

function isNonRuntimePerformanceSupportPath(
    filePath: string,
    classificationConfig: ReturnType<typeof getClassificationConfig>
): boolean {
    const normalizedPath = normalizePath(filePath);
    if (!hasPerformanceSupportDirectory(normalizedPath)) {
        return false;
    }
    if (pathStartsWithConfiguredRoot(normalizedPath, classificationConfig.runtime_roots)) {
        return false;
    }
    return matchAnyRegex(normalizedPath, classificationConfig.performance_trigger_regexes, {
        skipInvalidRegex: true,
        caseInsensitive: true
    });
}

function usesStagedContent(preflight: Record<string, unknown>): boolean {
    const detectionSource = getDetectionSource(preflight);
    return detectionSource === 'git_staged_only' || detectionSource === 'git_staged_plus_untracked';
}

const REVIEW_REUSE_NEUTRAL_WORKFLOW_CONFIG_PATHS = new Set([
    'garda-agent-orchestrator/live/config/workflow-config.json',
    'live/config/workflow-config.json'
]);

const REVIEW_REUSE_NEUTRAL_WORKFLOW_CONFIG_FIELDS = new Set([
    'review_cycle_guard.max_failed_non_test_reviews',
    'review_cycle_guard.max_total_non_test_reviews'
]);

function isPlainJsonObject(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function canonicalJsonValue(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map((entry) => canonicalJsonValue(entry));
    }
    if (isPlainJsonObject(value)) {
        return Object.keys(value)
            .sort()
            .reduce<Record<string, unknown>>((accumulator, key) => {
                accumulator[key] = canonicalJsonValue(value[key]);
                return accumulator;
            }, {});
    }
    return value;
}

function jsonValuesEqual(left: unknown, right: unknown): boolean {
    return JSON.stringify(canonicalJsonValue(left)) === JSON.stringify(canonicalJsonValue(right));
}

function collectJsonDiffPaths(left: unknown, right: unknown, parentPath = ''): string[] {
    if (jsonValuesEqual(left, right)) {
        return [];
    }
    if (!isPlainJsonObject(left) || !isPlainJsonObject(right)) {
        return [parentPath || '<root>'];
    }
    const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
    const diffPaths: string[] = [];
    for (const key of [...keys].sort()) {
        const childPath = parentPath ? `${parentPath}.${key}` : key;
        diffPaths.push(...collectJsonDiffPaths(left[key], right[key], childPath));
    }
    return diffPaths;
}

function readGitObjectText(repoRoot: string, objectName: string): string | null {
    try {
        const result = childProcess.spawnSync('git', ['show', objectName], {
            cwd: repoRoot,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
            timeout: 30_000
        });
        if (result.status !== 0) {
            return null;
        }
        return String(result.stdout || '');
    } catch {
        return null;
    }
}

function readCurrentWorkflowConfigText(
    repoRoot: string,
    preflight: Record<string, unknown>,
    relativePath: string
): string | null {
    if (usesStagedContent(preflight)) {
        const stagedText = readGitObjectText(repoRoot, `:${relativePath}`);
        if (stagedText !== null) {
            return stagedText;
        }
        if (getDetectionSource(preflight) === 'git_staged_only') {
            return null;
        }
    }

    const absolutePath = path.resolve(repoRoot, ...relativePath.split('/'));
    try {
        if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) {
            return null;
        }
        return fs.readFileSync(absolutePath, 'utf8');
    } catch {
        return null;
    }
}

export function isReviewReuseNeutralWorkflowConfigChange(
    preflight: Record<string, unknown>,
    repoRoot: string,
    filePath: string
): boolean {
    const relativePath = normalizePath(filePath);
    if (!REVIEW_REUSE_NEUTRAL_WORKFLOW_CONFIG_PATHS.has(relativePath)) {
        return false;
    }

    const baselineText = readGitObjectText(repoRoot, `HEAD:${relativePath}`);
    const currentText = readCurrentWorkflowConfigText(repoRoot, preflight, relativePath);
    if (baselineText === null || currentText === null) {
        return false;
    }

    try {
        const baseline = JSON.parse(baselineText) as unknown;
        const current = JSON.parse(currentText) as unknown;
        const diffPaths = collectJsonDiffPaths(baseline, current);
        return diffPaths.every((diffPath) => REVIEW_REUSE_NEUTRAL_WORKFLOW_CONFIG_FIELDS.has(diffPath));
    } catch {
        return false;
    }
}

function collectReviewReuseNeutralConfigFiles(
    preflight: Record<string, unknown>,
    repoRoot: string,
    allChangedFiles: readonly string[]
): string[] {
    return allChangedFiles
        .filter((filePath) => isReviewReuseNeutralWorkflowConfigChange(preflight, repoRoot, filePath))
        .sort();
}

function getTaskOwnedManualValidationEvidenceTail(preflight: Record<string, unknown>, filePath: string): string | null {
    const taskId = String(preflight.task_id || '').trim();
    if (!taskId) {
        return null;
    }
    const normalizedPath = normalizePath(filePath);
    const matchedPrefix = [
        `garda-agent-orchestrator/runtime/manual-validation/${taskId}/`,
        `runtime/manual-validation/${taskId}/`
    ].find((prefix) => normalizedPath.startsWith(prefix));
    return matchedPrefix ? normalizedPath.slice(matchedPrefix.length) : null;
}

function isAllowedManualValidationEvidenceTail(tail: string): boolean {
    return (
        tail === 'review-evidence.json'
        || tail === 'selector.json'
        || (/^[A-Za-z0-9._-]+\.log$/).test(tail)
    );
}

function collectReviewReuseNeutralEvidenceFiles(
    preflight: Record<string, unknown>,
    repoRoot: string,
    allChangedFiles: readonly string[],
    stagedBlobFingerprints?: StagedBlobFingerprints
): string[] {
    return allChangedFiles
        .filter((filePath) => {
            const tail = getTaskOwnedManualValidationEvidenceTail(preflight, filePath);
            if (!tail || !isAllowedManualValidationEvidenceTail(tail)) {
                return false;
            }
            if (usesStagedContent(preflight)) {
                const stagedFingerprint = stagedBlobFingerprints?.get(filePath) || null;
                if (stagedFingerprint) {
                    const stagedMode = stagedFingerprint.split(':')[1];
                    return stagedMode === '100644' || stagedMode === '100755';
                }
                if (getDetectionSource(preflight) === 'git_staged_only') {
                    return false;
                }
            }
            return getSafeWorktreePathState(repoRoot, filePath).status === 'file';
        })
        .sort();
}

function collectReviewReuseNeutralCloseoutFiles(allChangedFiles: readonly string[]): string[] {
    return allChangedFiles
        .filter((filePath) => isReviewReuseNeutralCloseoutEvidencePath(filePath))
        .sort();
}

function getScopedContentFingerprint(
    repoRoot: string,
    preflight: Record<string, unknown>,
    relativePath: string,
    stagedBlobFingerprints?: StagedBlobFingerprints
): { fingerprint: string | null; missing: boolean } {
    if (usesStagedContent(preflight)) {
        const stagedFingerprint = stagedBlobFingerprints?.get(relativePath) || null;
        if (stagedFingerprint) {
            return { fingerprint: stagedFingerprint, missing: false };
        }
        if (getDetectionSource(preflight) === 'git_staged_only') {
            return { fingerprint: null, missing: true };
        }
    }
    const state = getSafeWorktreePathState(repoRoot, relativePath);
    if (state.status === 'file') {
        return {
            fingerprint: state.sha256 ? `worktree:file:${state.sha256}` : null,
            missing: !state.sha256
        };
    }
    if (state.status === 'symbolic_link') {
        return {
            fingerprint: [
                'worktree:symlink',
                state.link_sha256 || 'UNHASHABLE',
                state.target_status || 'unknown',
                state.target_path || '',
                state.target_mode ?? 0,
                state.target_size ?? 0,
                state.target_sha256 || 'UNHASHABLE'
            ].join(':'),
            missing: state.target_status === 'file' && !state.target_sha256
        };
    }
    if (state.status === 'unreviewable_symlink') {
        return {
            fingerprint: [
                'worktree:unreviewable_symlink',
                state.link_sha256 || 'UNHASHABLE',
                state.target_status || 'unknown',
                state.target_path || '',
                state.target_mode ?? 0,
                state.target_size ?? 0
            ].join(':'),
            missing: false
        };
    }
    if (state.status === 'outside_repo') {
        return { fingerprint: 'worktree:outside_repo', missing: false };
    }
    if (state.status === 'directory') {
        return { fingerprint: 'worktree:directory', missing: false };
    }
    if (state.status === 'special') {
        return { fingerprint: `worktree:special:${state.mode ?? 0}:${state.size ?? 0}`, missing: false };
    }
    return { fingerprint: null, missing: true };
}

function computeCodeReviewScopeFingerprintInternal(
    preflight: Record<string, unknown>,
    repoRoot: string,
    options: {
        excludeNonRuntimePerformanceSupportFiles?: boolean;
        classificationConfig?: ResolvedClassificationConfig;
        stagedBlobFingerprints?: StagedBlobFingerprints;
    } = {}
): CodeReviewScopeFingerprint {
    const classificationConfig = resolveReviewReuseClassificationConfig(
        preflight,
        repoRoot,
        options.classificationConfig
    );
    const allChangedFiles = Array.isArray(preflight.changed_files)
        ? preflight.changed_files.map((entry) => normalizePath(entry)).filter(Boolean)
        : [];
    const stagedBlobFingerprints = usesStagedContent(preflight)
        ? options.stagedBlobFingerprints || readStagedBlobFingerprints(repoRoot, allChangedFiles)
        : undefined;
    const testChangedFiles = allChangedFiles.filter((filePath) => matchAnyRegex(filePath, classificationConfig.test_trigger_regexes, {
        skipInvalidRegex: true,
        caseInsensitive: true
    }));
    const docsOnlyChangedFiles = allChangedFiles.filter((filePath) => (
        isSafeOrdinaryDocumentationPath(filePath, classificationConfig)
        && !isCloseoutEvidencePath(filePath)
    ));
    const performanceSupportChangedFiles = allChangedFiles.filter((filePath) => (
        isNonRuntimePerformanceSupportPath(filePath, classificationConfig)
    ));
    const reviewReuseNeutralConfigFiles = collectReviewReuseNeutralConfigFiles(preflight, repoRoot, allChangedFiles);
    const performanceSupportSet = new Set(
        options.excludeNonRuntimePerformanceSupportFiles ? performanceSupportChangedFiles : []
    );
    const reviewReuseNeutralConfigSet = new Set(reviewReuseNeutralConfigFiles);
    const reviewReuseNeutralEvidenceFiles = collectReviewReuseNeutralEvidenceFiles(
        preflight,
        repoRoot,
        allChangedFiles,
        stagedBlobFingerprints
    );
    const reviewReuseNeutralEvidenceSet = new Set(reviewReuseNeutralEvidenceFiles);
    const reviewReuseNeutralCloseoutFiles = collectReviewReuseNeutralCloseoutFiles(allChangedFiles);
    const reviewReuseNeutralCloseoutSet = new Set(reviewReuseNeutralCloseoutFiles);
    const nonTestChangedFiles = allChangedFiles.filter((filePath) => (
        !testChangedFiles.includes(filePath)
        && !docsOnlyChangedFiles.includes(filePath)
        && !performanceSupportSet.has(filePath)
        && !reviewReuseNeutralConfigSet.has(filePath)
        && !reviewReuseNeutralEvidenceSet.has(filePath)
        && !reviewReuseNeutralCloseoutSet.has(filePath)
    ));
    const sortedNonTestFiles = [...nonTestChangedFiles].sort();
    const missingNonTestFiles: string[] = [];
    const fingerprintEntries = sortedNonTestFiles.map((relativePath) => {
        const scopedFingerprint = getScopedContentFingerprint(
            repoRoot,
            preflight,
            relativePath,
            stagedBlobFingerprints
        );
        if (scopedFingerprint.missing) {
            missingNonTestFiles.push(relativePath);
        }
        return `${relativePath}:${scopedFingerprint.fingerprint || 'MISSING'}`;
    });

    return {
        all_changed_files: allChangedFiles,
        non_test_changed_files: sortedNonTestFiles,
        docs_only_changed_files: [...docsOnlyChangedFiles].sort(),
        performance_support_changed_files: [...performanceSupportChangedFiles].sort(),
        review_reuse_neutral_config_files: reviewReuseNeutralConfigFiles,
        review_reuse_neutral_evidence_files: reviewReuseNeutralEvidenceFiles,
        review_reuse_neutral_closeout_files: reviewReuseNeutralCloseoutFiles,
        missing_non_test_files: missingNonTestFiles,
        code_scope_sha256: stringSha256(fingerprintEntries.join('\n')),
        test_only: sortedNonTestFiles.length === 0 && testChangedFiles.length === allChangedFiles.length,
        docs_only: sortedNonTestFiles.length === 0 && docsOnlyChangedFiles.length === allChangedFiles.length,
        documentation_review: docsOnlyChangedFiles.length > 0 && allChangedFiles.every((file) =>
            !isCloseoutEvidencePath(file) && (docsOnlyChangedFiles.includes(file) || testChangedFiles.includes(file)))
    };
}

export function computeCodeReviewScopeFingerprint(
    preflight: Record<string, unknown>,
    repoRoot: string
): CodeReviewScopeFingerprint {
    return computeCodeReviewScopeFingerprintInternal(preflight, repoRoot);
}

export function computeReviewReuseCodeScopeFingerprint(
    reviewType: string,
    preflight: Record<string, unknown>,
    repoRoot: string,
    classificationConfig?: ResolvedClassificationConfig,
    stagedBlobFingerprints?: StagedBlobFingerprints
): CodeReviewScopeFingerprint {
    const normalizedReviewType = String(reviewType || '').trim().toLowerCase();
    const scopeOptions = {
        excludeNonRuntimePerformanceSupportFiles: normalizedReviewType === 'code',
        classificationConfig,
        stagedBlobFingerprints
    };
    const scope = computeCodeReviewScopeFingerprintInternal(preflight, repoRoot, scopeOptions);
    const reviewPreflight = resolveReviewPreflightWithoutCloseout(preflight);
    const reviewScope = reviewPreflight.changed_files.length === scope.all_changed_files.length
        ? scope
        : computeCodeReviewScopeFingerprintInternal(reviewPreflight, repoRoot, scopeOptions);
    if (!reviewScope.test_only || reviewScope.all_changed_files.length === 0) {
        return scope;
    }
    // A test-only lane must bind the same test bytes assigned by its coverage contract.
    return {
        ...reviewScope,
        code_scope_sha256: computeReviewRelevantScopeFingerprint(
            reviewPreflight, repoRoot, classificationConfig, stagedBlobFingerprints
        ).review_scope_sha256
    };
}

function resolveReviewPreflightWithoutCloseout(
    preflight: Record<string, unknown>
): Record<string, unknown> & { changed_files: string[] } {
    const changedFiles = Array.isArray(preflight.changed_files)
        ? preflight.changed_files.map((entry) => normalizePath(entry)).filter((file) => file && !isCloseoutEvidencePath(file))
        : [];
    return { ...preflight, changed_files: changedFiles };
}

export function computeReviewRelevantScopeWithoutCloseout(
    preflight: Record<string, unknown>,
    repoRoot: string,
    classificationConfig?: ResolvedClassificationConfig,
    stagedBlobFingerprints?: StagedBlobFingerprints
): ReviewRelevantScopeFingerprint {
    return computeReviewRelevantScopeFingerprint(
        resolveReviewPreflightWithoutCloseout(preflight), repoRoot, classificationConfig, stagedBlobFingerprints
    );
}

export function computeReviewRelevantScopeFingerprint(
    preflight: Record<string, unknown>,
    repoRoot: string,
    classificationConfig?: ResolvedClassificationConfig,
    stagedBlobFingerprints?: StagedBlobFingerprints
): ReviewRelevantScopeFingerprint {
    const resolvedClassificationConfig = resolveReviewReuseClassificationConfig(
        preflight,
        repoRoot,
        classificationConfig
    );
    const allChangedFiles = Array.isArray(preflight.changed_files)
        ? preflight.changed_files.map((entry) => normalizePath(entry)).filter(Boolean)
        : [];
    const resolvedStagedBlobFingerprints = usesStagedContent(preflight)
        ? stagedBlobFingerprints || readStagedBlobFingerprints(repoRoot, allChangedFiles)
        : undefined;
    const docsOnlyChangedFiles = allChangedFiles.filter((filePath) => (
        isSafeOrdinaryDocumentationPath(filePath, resolvedClassificationConfig)
        && !isCloseoutEvidencePath(filePath)
    ));
    const docsOnlySet = new Set(docsOnlyChangedFiles);
    const reviewReuseNeutralConfigFiles = collectReviewReuseNeutralConfigFiles(preflight, repoRoot, allChangedFiles);
    const reviewReuseNeutralConfigSet = new Set(reviewReuseNeutralConfigFiles);
    const reviewReuseNeutralCloseoutFiles = collectReviewReuseNeutralCloseoutFiles(allChangedFiles);
    const reviewReuseNeutralCloseoutSet = new Set(reviewReuseNeutralCloseoutFiles);
    const reviewRelevantFiles = allChangedFiles.filter((filePath) => (
        !docsOnlySet.has(filePath)
        && !reviewReuseNeutralConfigSet.has(filePath)
        && !reviewReuseNeutralCloseoutSet.has(filePath)
    ));
    const sortedReviewRelevantFiles = [...reviewRelevantFiles].sort();
    const missingReviewRelevantFiles: string[] = [];
    const fingerprintEntries = sortedReviewRelevantFiles.map((relativePath) => {
        const scopedFingerprint = getScopedContentFingerprint(
            repoRoot,
            preflight,
            relativePath,
            resolvedStagedBlobFingerprints
        );
        if (scopedFingerprint.missing) {
            missingReviewRelevantFiles.push(relativePath);
        }
        return `${relativePath}:${scopedFingerprint.fingerprint || 'MISSING'}`;
    });

    return {
        all_changed_files: allChangedFiles,
        review_relevant_changed_files: sortedReviewRelevantFiles,
        docs_only_changed_files: [...docsOnlyChangedFiles].sort(),
        review_reuse_neutral_config_files: reviewReuseNeutralConfigFiles,
        review_reuse_neutral_evidence_files: [],
        review_reuse_neutral_closeout_files: reviewReuseNeutralCloseoutFiles,
        missing_review_relevant_files: missingReviewRelevantFiles,
        review_scope_sha256: stringSha256(fingerprintEntries.join('\n')),
        docs_only: sortedReviewRelevantFiles.length === 0 && docsOnlyChangedFiles.length === allChangedFiles.length,
        documentation_review: docsOnlyChangedFiles.length > 0 && allChangedFiles.every((file) =>
            !isCloseoutEvidencePath(file) && (docsOnlyChangedFiles.includes(file) || matchAnyRegex(file, resolvedClassificationConfig.test_trigger_regexes, {
                skipInvalidRegex: true, caseInsensitive: true
            })))
    };
}

function buildReviewContextReuseHashSnapshot(
    reviewContext: Record<string, unknown>,
    schemaVersion: number | null,
    includeReviewExecution: boolean
): Record<string, unknown> {
    const rulePack = toRecord(reviewContext.rule_pack);
    const tokenEconomy = toRecord(reviewContext.token_economy);
    const ruleContext = toRecord(reviewContext.rule_context);
    const scopedDiff = toRecord(reviewContext.scoped_diff);
    const reviewerRouting = toRecord(reviewContext.reviewer_routing);
    const plan = toRecord(reviewContext.plan);
    const contractBindings = resolveReviewContextReuseContractBindings(reviewContext);
    const documentationScopeSha256 = resolveDocumentationReviewScopeHash(
        toRecord(reviewContext.tree_state).domain_scope_fingerprints
    );
    const testOnlyScopeSha256 = resolveTestOnlyReviewScopeHash(
        toRecord(reviewContext.tree_state).domain_scope_fingerprints
    );

    return {
        schema_version: schemaVersion,
        review_type: String(reviewContext.review_type || '').trim().toLowerCase() || null,
        depth: typeof reviewContext.depth === 'number' ? reviewContext.depth : null,
        token_economy_active: reviewContext.token_economy_active === true,
        required_review: reviewContext.required_review === true,
        rule_pack: {
            selected_rule_files: toStringList(rulePack.selected_rule_files),
            omitted_rule_files: toStringList(rulePack.omitted_rule_files),
            omission_reason: String(rulePack.omission_reason || '').trim() || null
        },
        token_economy: {
            active: tokenEconomy.active === true,
            flags: toRecord(tokenEconomy.flags),
            omitted_sections: toSectionList(tokenEconomy.omitted_sections),
            omission_reason: String(tokenEconomy.omission_reason || '').trim() || null
        },
        rule_context: {
            reuse_contract_sha256: contractBindings.ruleContextSha256,
            source_file_count: typeof ruleContext.source_file_count === 'number' ? ruleContext.source_file_count : null,
            strip_examples_applied: ruleContext.strip_examples_applied === true,
            strip_code_blocks_applied: ruleContext.strip_code_blocks_applied === true,
            source_files: toSourceFileSummary(ruleContext.source_files)
        },
        coverage_contract: {
            contract_sha256: contractBindings.coverageContractSha256
        },
        ...(documentationScopeSha256 ? { documentation_scope_sha256: documentationScopeSha256 } : {}),
        ...(testOnlyScopeSha256 ? { test_only_scope_sha256: testOnlyScopeSha256 } : {}),
        ...(includeReviewExecution
            ? {
                review_execution: {
                    mode: contractBindings.reviewExecutionMode,
                    ...(contractBindings.reviewExecutionMode === 'DELTA'
                        ? { full_review_scope_sha256: contractBindings.reviewExecutionFullScopeSha256 }
                        : {})
                }
            }
            : {}),
        scoped_diff: {
            expected: scopedDiff.expected === true,
            metadata: buildScopedDiffReuseMetadata(scopedDiff.metadata)
        },
        reviewer_routing: {
            source_of_truth: String(reviewerRouting.source_of_truth || '').trim() || null,
            canonical_source_of_truth: String(reviewerRouting.canonical_source_of_truth || '').trim() || null,
            canonical_entrypoint: String(reviewerRouting.canonical_entrypoint || '').trim() || null,
            execution_provider: String(reviewerRouting.execution_provider || '').trim() || null,
            execution_provider_source: String(reviewerRouting.execution_provider_source || '').trim() || null,
            routed_to: String(reviewerRouting.routed_to || '').trim() || null,
            provider_bridge: String(reviewerRouting.provider_bridge || '').trim() || null,
            identity_status: String(reviewerRouting.identity_status || '').trim() || null,
            identity_violations: toStringList(reviewerRouting.identity_violations),
            capability_level: String(reviewerRouting.capability_level || '').trim() || null,
            delegation_required: reviewerRouting.delegation_required === true,
            expected_execution_mode: String(reviewerRouting.expected_execution_mode || '').trim() || null,
            fallback_allowed: reviewerRouting.fallback_allowed !== false,
            fallback_reason_required: reviewerRouting.fallback_reason_required === true,
            reviewer_execution_mode_required: reviewerRouting.reviewer_execution_mode_required === true,
            reviewer_identity_required: reviewerRouting.reviewer_identity_required === true,
            note: String(reviewerRouting.note || '').trim() || null
        },
        plan: {
            plan_guided: plan.plan_guided === true,
            plan_sha256: String(plan.plan_sha256 || '').trim().toLowerCase() || null,
            plan_summary: String(plan.plan_summary || '').trim() || null
        }
    };
}

export function computeSchema3ReviewContextReuseCompatibilityHash(
    reviewContext: Record<string, unknown>
): string | null {
    if (!reviewContext || typeof reviewContext !== 'object' || Array.isArray(reviewContext)) {
        return null;
    }
    return stringSha256(JSON.stringify(buildReviewContextReuseHashSnapshot(reviewContext, 3, false)));
}

export function computeReviewContextReuseHash(reviewContext: Record<string, unknown>): string | null {
    if (!reviewContext || typeof reviewContext !== 'object' || Array.isArray(reviewContext)) {
        return null;
    }

    const schemaVersion = typeof reviewContext.schema_version === 'number'
        ? reviewContext.schema_version
        : null;
    if (schemaVersion === 3) {
        return computeSchema3ReviewContextReuseCompatibilityHash(reviewContext);
    }

    return stringSha256(JSON.stringify(
        buildReviewContextReuseHashSnapshot(reviewContext, schemaVersion, true)
    ));
}
