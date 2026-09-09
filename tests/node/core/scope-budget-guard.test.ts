import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
    evaluateScopeBudgetGuard,
    normalizeScopeBudgetGuardConfig,
    parseScopeBudgetNumber,
    readScopeBudgetChangedFilesCount,
    readScopeBudgetChangedLinesTotal,
    readScopeBudgetEffectivePreflightMetric
} from '../../../src/core/scope-budget-guard';

function createThresholdConfig() {
    return normalizeScopeBudgetGuardConfig({
        enabled: true,
        profiles: ['balanced'],
        action: 'BLOCK_FOR_SPLIT',
        warn_files: 2,
        block_files: 4,
        warn_changed_lines: 10,
        block_changed_lines: 20,
        warn_required_reviews: 1,
        block_required_reviews: 3,
        warn_review_tokens: 100,
        block_review_tokens: 200
    });
}

describe('scope budget metric readers', () => {
    it('parses finite numeric values and rejects unusable inputs', () => {
        assert.equal(parseScopeBudgetNumber(12), 12);
        assert.equal(parseScopeBudgetNumber(' 14 '), 14);
        assert.equal(parseScopeBudgetNumber(''), null);
        assert.equal(parseScopeBudgetNumber('Infinity'), null);
        assert.equal(parseScopeBudgetNumber(Number.NaN), null);
        assert.equal(parseScopeBudgetNumber({ value: 1 }), null);
    });

    it('uses companion-scope metrics only when the matching trigger is active', () => {
        const metrics = {
            changed_files_count: 8,
            changed_lines_total: 80,
            review_trigger_effective_changed_files_count: '3',
            companion_scope_effective_changed_lines_total: '30'
        };
        const ordinaryPreflight = {
            changed_files: ['a.ts'],
            metrics
        };
        const companionPreflight = {
            ...ordinaryPreflight,
            triggers: { ui_i18n_companion_scope: true }
        };

        assert.equal(readScopeBudgetEffectivePreflightMetric(ordinaryPreflight, 'changed_files_count'), null);
        assert.equal(readScopeBudgetChangedFilesCount(ordinaryPreflight), 8);
        assert.equal(readScopeBudgetChangedLinesTotal(ordinaryPreflight), 80);
        assert.equal(readScopeBudgetChangedFilesCount(companionPreflight), 3);
        assert.equal(readScopeBudgetChangedLinesTotal(companionPreflight), 30);
    });

    it('falls back to changed-file and budget-forecast evidence', () => {
        const preflight = {
            changed_files: ['a.ts', 'b.ts'],
            budget_forecast: { changed_lines_total: '21' }
        };

        assert.equal(readScopeBudgetChangedFilesCount(preflight), 2);
        assert.equal(readScopeBudgetChangedLinesTotal(preflight), 21);
        assert.equal(readScopeBudgetChangedFilesCount(null), 0);
        assert.equal(readScopeBudgetChangedLinesTotal(null), 0);
    });
});

describe('scope budget configuration and evaluation', () => {
    it('normalizes legacy blocking thresholds without collapsing warning headroom', () => {
        const config = normalizeScopeBudgetGuardConfig({
            action: 'block-for-split',
            profiles: [' Strict ', 'strict', 'BALANCED'],
            max_files: 3,
            max_changed_lines: 100,
            max_required_reviews: 2,
            max_review_tokens: 1000
        });

        assert.equal(config.action, 'BLOCK_FOR_SPLIT');
        assert.deepEqual(config.profiles, ['strict', 'balanced']);
        assert.equal(config.warn_files, 2);
        assert.equal(config.block_files, 3);
        assert.equal(config.warn_changed_lines, 99);
        assert.equal(config.block_changed_lines, 100);
        assert.equal(config.warn_required_reviews, 1);
        assert.equal(config.block_required_reviews, 2);
        assert.equal(config.warn_review_tokens, 999);
        assert.equal(config.block_review_tokens, 1000);
    });

    it('stays neutral at warning thresholds and inactive for an unmatched profile', () => {
        const config = createThresholdConfig();
        const atThreshold = evaluateScopeBudgetGuard(config, {
            profileName: ' BALANCED ',
            changedFilesCount: 2,
            changedLinesTotal: 10,
            requiredReviewCount: 1,
            totalEstimatedReviewTokens: 100
        });
        const inactive = evaluateScopeBudgetGuard(config, {
            profileName: 'docs-only',
            changedFilesCount: 500,
            changedLinesTotal: 5000,
            requiredReviewCount: 20,
            totalEstimatedReviewTokens: 500_000
        });

        assert.equal(atThreshold.status, 'OK');
        assert.equal(atThreshold.continuation_allowed, true);
        assert.deepEqual(atThreshold.violations, []);
        assert.equal(atThreshold.summary_line, 'Scope budget guard: within configured limits');
        assert.equal(inactive.status, 'INACTIVE');
        assert.equal(inactive.active, false);
        assert.equal(inactive.continuation_allowed, true);
        assert.deepEqual(inactive.violations, []);
    });

    it('reports warning and blocking thresholds with deterministic dispositions', () => {
        const config = createThresholdConfig();
        const warning = evaluateScopeBudgetGuard(config, {
            profileName: 'balanced',
            changedFilesCount: 3,
            changedLinesTotal: 11,
            requiredReviewCount: 2,
            totalEstimatedReviewTokens: 101
        });
        const blocking = evaluateScopeBudgetGuard(config, {
            profileName: 'balanced',
            changedFilesCount: 5,
            changedLinesTotal: 11,
            requiredReviewCount: 1,
            totalEstimatedReviewTokens: 100
        });

        assert.equal(warning.status, 'WARN');
        assert.equal(warning.should_warn, true);
        assert.equal(warning.should_block, false);
        assert.equal(warning.continuation_allowed, true);
        assert.deepEqual(warning.violations.map((violation) => violation.severity), [
            'WARN', 'WARN', 'WARN', 'WARN'
        ]);

        assert.equal(blocking.status, 'BLOCK');
        assert.equal(blocking.should_warn, false);
        assert.equal(blocking.should_block, true);
        assert.equal(blocking.continuation_allowed, false);
        assert.deepEqual(blocking.violations, [
            {
                metric: 'changed_files_count',
                actual: 5,
                limit: 4,
                warning_limit: 2,
                blocking_limit: 4,
                severity: 'BLOCK'
            },
            {
                metric: 'changed_lines_total',
                actual: 11,
                limit: 10,
                warning_limit: 10,
                blocking_limit: 20,
                severity: 'WARN'
            }
        ]);
    });
});
