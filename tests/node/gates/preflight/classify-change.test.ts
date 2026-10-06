import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    classifyChange,
    classifyScopeCategory,
    getDefaultClassificationConfig,
    getClassificationConfig
} from '../../../../src/gates/preflight/classify-change';
import {
    matchOrdinaryDocPathPattern,
    normalizeOrdinaryDocPathPatterns
} from '../../../../src/core/ordinary-doc-paths';
import { defaultCapabilities, makeConfig } from './classify-change-test-support';

describe('gates/classify-change', () => {
    describe('getDefaultClassificationConfig', () => {
        it('returns valid default config with triggers', () => {
            const config = getDefaultClassificationConfig('/repo');
            assert.ok(config.triggers);
            assert.ok(config.triggers.db.length > 0);
            assert.ok(config.triggers.security.length > 0);
            assert.ok(config.runtime_roots.length > 0);
            assert.ok(config.code_like_regexes.length > 0);
        });
    });

    describe('ordinary doc path validation', () => {
        it('rejects repository-wide ordinary doc wildcard globs', () => {
            assert.throws(
                () => normalizeOrdinaryDocPathPatterns(['**/*.md'], 'paths.ordinary_doc_paths'),
                /repository-wide wildcard/
            );
            assert.throws(
                () => normalizeOrdinaryDocPathPatterns(['*/README.md'], 'paths.ordinary_doc_paths'),
                /repository-wide wildcard/
            );
        });

        it('allows ordinary doc globs anchored under a concrete path segment', () => {
            assert.deepEqual(
                normalizeOrdinaryDocPathPatterns(['docs/**/*.md'], 'paths.ordinary_doc_paths'),
                ['docs/**/*.md']
            );
        });

        it('does not reuse stale matchers when a pattern array is mutated', () => {
            const patterns = ['docs/plan.md'];

            assert.equal(matchOrdinaryDocPathPattern('docs/plan.md', patterns), 'docs/plan.md');
            patterns[0] = 'CHANGELOG.md';

            assert.equal(matchOrdinaryDocPathPattern('docs/plan.md', patterns), null);
            assert.equal(matchOrdinaryDocPathPattern('CHANGELOG.md', patterns), 'CHANGELOG.md');
        });
    });

    describe('classifyChange', () => {
        it('returns FAST_PATH for small frontend change', () => {
            const result = classifyChange({
                normalizedFiles: ['frontend/Button.tsx'],
                taskIntent: 'Update button styles',
                changedLinesTotal: 10,
                additionsTotal: 8,
                deletionsTotal: 2,
                renameCount: 0,
                detectionSource: 'git_auto',
                classificationConfig: makeConfig(),
                reviewCapabilities: defaultCapabilities
            });
            assert.equal(result.mode, 'FAST_PATH');
            assert.equal(result.triggers.fast_path_eligible, true);
            assert.equal(result.required_reviews.code, false);
        });

        it('keeps mechanical UI language-pack companion changes on the fast path', () => {
            const driverFile = 'src/reports/ui/dashboard-client-quality-gate.ts';
            const langPackFiles = [
                'src/reports/ui/lang-packs/garda-ui-de.json',
                'src/reports/ui/lang-packs/garda-ui-en.json',
                'src/reports/ui/lang-packs/garda-ui-es.json',
                'src/reports/ui/lang-packs/garda-ui-fr.json',
                'src/reports/ui/lang-packs/garda-ui-ru.json'
            ];
            const changedFileStats = Object.fromEntries([
                [driverFile, { additions: 8, deletions: 4, changed_lines: 12 }],
                ...langPackFiles.map((filePath) => [filePath, { additions: 20, deletions: 4, changed_lines: 24 }])
            ]);

            const result = classifyChange({
                normalizedFiles: [driverFile, ...langPackFiles],
                taskIntent: 'Update Quality Gate UI labels and generated language packs',
                changedLinesTotal: 132,
                additionsTotal: 108,
                deletionsTotal: 24,
                changedFileStats,
                renameCount: 0,
                detectionSource: 'explicit_changed_files',
                classificationConfig: makeConfig(),
                reviewCapabilities: { ...defaultCapabilities, performance: true, test: true }
            });

            assert.equal(result.mode, 'FAST_PATH');
            assert.equal(result.scope_category, 'code');
            assert.equal(result.triggers.fast_path_eligible, true);
            assert.equal(result.triggers.ui_i18n_companion_scope, true);
            assert.equal(result.triggers.ui_i18n_companion_reason, 'ui_i18n_companion_scope');
            assert.equal(result.triggers.ui_i18n_review_trigger_suppressed, true);
            assert.deepEqual(result.triggers.ui_i18n_review_trigger_files, [driverFile]);
            assert.deepEqual(result.triggers.ui_i18n_review_trigger_suppressed_files, langPackFiles);
            assert.deepEqual(result.triggers.ui_i18n_companion_driver_files, [driverFile]);
            assert.deepEqual(result.triggers.ui_i18n_companion_files, langPackFiles);
            assert.equal(result.metrics.review_trigger_effective_changed_files_count, 1);
            assert.equal(result.metrics.review_trigger_effective_changed_lines_total, 12);
            assert.equal(result.metrics.review_trigger_suppressed_files_count, langPackFiles.length);
            assert.equal(result.metrics.companion_scope_kind, 'ui-i18n');
            assert.equal(result.metrics.companion_scope_effective_changed_files_count, 1);
            assert.equal(result.metrics.companion_scope_effective_changed_lines_total, 12);
            assert.equal(result.metrics.companion_scope_exempted_files_count, langPackFiles.length);
            assert.equal(result.required_reviews.code, false);
            assert.equal(result.required_reviews.performance, false);
        });

        it('keeps standalone UI language-pack edits audited without review-trigger pressure', () => {
            const langPackFile = 'src/reports/ui/lang-packs/garda-ui-ru.json';
            const result = classifyChange({
                normalizedFiles: [langPackFile],
                taskIntent: 'Update Russian UI translation',
                changedLinesTotal: 24,
                additionsTotal: 20,
                deletionsTotal: 4,
                changedFileStats: {
                    [langPackFile]: { additions: 20, deletions: 4, changed_lines: 24 }
                },
                renameCount: 0,
                detectionSource: 'explicit_changed_files',
                classificationConfig: makeConfig(),
                reviewCapabilities: defaultCapabilities
            });

            assert.equal(result.mode, 'FULL_PATH');
            assert.equal(result.triggers.ui_i18n_companion_scope, false);
            assert.equal(result.triggers.ui_i18n_companion_reason, 'standalone_i18n_scope');
            assert.equal(result.triggers.ui_i18n_review_trigger_suppressed, true);
            assert.deepEqual(result.triggers.ui_i18n_review_trigger_files, []);
            assert.deepEqual(result.triggers.ui_i18n_review_trigger_suppressed_files, [langPackFile]);
            assert.deepEqual(result.changed_files, [langPackFile]);
            assert.equal(result.metrics.changed_files_count, 1);
            assert.equal(result.metrics.changed_lines_total, 24);
            assert.equal(result.metrics.review_trigger_effective_changed_files_count, 0);
            assert.equal(result.metrics.review_trigger_effective_changed_lines_total, 0);
            assert.equal(result.metrics.companion_scope_kind, 'ui-i18n');
            assert.equal(result.required_reviews.api, false);
            assert.equal(result.required_reviews.test, false);
            assert.equal(result.required_reviews.performance, false);
            assert.equal(result.required_reviews.infra, false);
            assert.equal(result.required_reviews.dependency, false);
        });

        it('keeps workflow-setting text packs audited without review-trigger pressure', () => {
            const textPackFiles = [
                'src/reports/ui/workflow-setting-text/en-reference.json',
                'src/reports/ui/workflow-setting-text/lang/ru.json',
                'src/reports/ui/workflow-setting-text/lang/de.json'
            ];
            const result = classifyChange({
                normalizedFiles: textPackFiles,
                taskIntent: 'Update API and performance wording in workflow-setting translations',
                changedLinesTotal: 420,
                additionsTotal: 300,
                deletionsTotal: 120,
                changedFileStats: Object.fromEntries(
                    textPackFiles.map((filePath) => [filePath, { additions: 100, deletions: 40, changed_lines: 140 }])
                ),
                renameCount: 0,
                detectionSource: 'explicit_changed_files',
                classificationConfig: makeConfig(),
                reviewCapabilities: {
                    ...defaultCapabilities,
                    api: true,
                    test: true,
                    performance: true,
                    infra: true,
                    dependency: true
                }
            });

            assert.equal(result.triggers.ui_i18n_companion_scope, false);
            assert.equal(result.triggers.ui_i18n_companion_reason, 'standalone_i18n_scope');
            assert.equal(result.triggers.ui_i18n_review_trigger_suppressed, true);
            assert.deepEqual(result.triggers.ui_i18n_companion_files, textPackFiles);
            assert.deepEqual(result.triggers.ui_i18n_review_trigger_files, []);
            assert.equal(result.metrics.changed_files_count, textPackFiles.length);
            assert.equal(result.metrics.changed_lines_total, 420);
            assert.equal(result.metrics.review_trigger_effective_changed_files_count, 0);
            assert.equal(result.metrics.review_trigger_effective_changed_lines_total, 0);
            assert.equal(result.triggers.performance_heuristic, false);
            assert.equal(result.required_reviews.api, false);
            assert.equal(result.required_reviews.test, false);
            assert.equal(result.required_reviews.performance, false);
            assert.equal(result.required_reviews.infra, false);
            assert.equal(result.required_reviews.dependency, false);
        });

        it('keeps mixed source, test, and config drivers while excluding localization files from trigger pressure', () => {
            const sourceFile = 'src/reports/ui/dashboard-client-workflow.ts';
            const testFile = 'tests/node/reports/workflow-setting-text-lang-packs.test.ts';
            const dependencyFile = 'package.json';
            const langPackFile = 'src/reports/ui/lang-packs/garda-ui-ru.json';
            const result = classifyChange({
                normalizedFiles: [sourceFile, testFile, dependencyFile, langPackFile],
                taskIntent: 'Update workflow UI behavior, tests, package metadata, and translations',
                changedLinesTotal: 180,
                additionsTotal: 140,
                deletionsTotal: 40,
                changedFileStats: {
                    [sourceFile]: { additions: 20, deletions: 5, changed_lines: 25 },
                    [testFile]: { additions: 30, deletions: 10, changed_lines: 40 },
                    [dependencyFile]: { additions: 2, deletions: 1, changed_lines: 3 },
                    [langPackFile]: { additions: 88, deletions: 24, changed_lines: 112 }
                },
                renameCount: 0,
                detectionSource: 'explicit_changed_files',
                classificationConfig: makeConfig(),
                reviewCapabilities: {
                    ...defaultCapabilities,
                    test: true,
                    dependency: true,
                    performance: true
                }
            });

            assert.equal(result.triggers.ui_i18n_companion_scope, false);
            assert.equal(result.triggers.ui_i18n_review_trigger_suppressed, true);
            assert.deepEqual(result.triggers.ui_i18n_review_trigger_files, [sourceFile, testFile, dependencyFile]);
            assert.equal(result.metrics.review_trigger_effective_changed_files_count, 3);
            assert.equal(result.metrics.review_trigger_effective_changed_lines_total, 68);
            assert.equal(result.triggers.test, true);
            assert.equal(result.triggers.dependency, true);
            assert.equal(result.required_reviews.test, true);
            assert.equal(result.required_reviews.dependency, true);
            assert.equal(result.triggers.performance_heuristic, false);
            assert.equal(result.required_reviews.performance, false);
        });

        it('does not fast-path non-UI config changes paired with language packs', () => {
            const configFile = 'garda-agent-orchestrator/live/config/workflow-config.json';
            const langPackFile = 'src/reports/ui/lang-packs/garda-ui-ru.json';
            const result = classifyChange({
                normalizedFiles: [configFile, langPackFile],
                taskIntent: 'Update workflow configuration and UI translation',
                changedLinesTotal: 36,
                additionsTotal: 30,
                deletionsTotal: 6,
                changedFileStats: {
                    [configFile]: { additions: 10, deletions: 2, changed_lines: 12 },
                    [langPackFile]: { additions: 20, deletions: 4, changed_lines: 24 }
                },
                renameCount: 0,
                detectionSource: 'explicit_changed_files',
                classificationConfig: makeConfig(),
                reviewCapabilities: defaultCapabilities
            });

            assert.equal(result.triggers.ui_i18n_companion_scope, false);
            assert.equal(result.triggers.ui_i18n_companion_reason, 'driver_not_ui_surface');
            assert.equal(result.triggers.ui_i18n_review_trigger_suppressed, true);
            assert.deepEqual(result.triggers.ui_i18n_review_trigger_files, [configFile]);
            assert.equal(result.metrics.review_trigger_effective_changed_files_count, 1);
            assert.equal(result.triggers.fast_path_eligible, false);
        });

        it('does not treat ordinary JSON config files as localization suppression scope', () => {
            const result = classifyChange({
                normalizedFiles: ['package.json'],
                taskIntent: 'Update package metadata',
                changedLinesTotal: 8,
                additionsTotal: 6,
                deletionsTotal: 2,
                changedFileStats: {
                    'package.json': { additions: 6, deletions: 2, changed_lines: 8 }
                },
                renameCount: 0,
                detectionSource: 'explicit_changed_files',
                classificationConfig: makeConfig(),
                reviewCapabilities: { ...defaultCapabilities, dependency: true }
            });

            assert.equal(result.triggers.ui_i18n_review_trigger_suppressed, false);
            assert.equal(result.metrics.review_trigger_effective_changed_files_count, undefined);
            assert.equal(result.triggers.dependency, true);
            assert.equal(result.required_reviews.dependency, true);
        });

        it('keeps default CHANGELOG.md as an ordinary doc path with auditable match evidence', () => {
            const result = classifyChange({
                normalizedFiles: ['CHANGELOG.md'],
                taskIntent: 'Update release notes',
                changedLinesTotal: 4,
                additionsTotal: 4,
                deletionsTotal: 0,
                renameCount: 0,
                detectionSource: 'explicit_changed_files',
                classificationConfig: makeConfig(),
                reviewCapabilities: defaultCapabilities
            });

            assert.equal(result.scope_category, 'docs-only');
            assert.equal(result.required_reviews.code, false);
            assert.equal(result.required_reviews.test, false);
            assert.deepEqual(result.triggers.ordinary_doc_path_matched_files, ['CHANGELOG.md']);
            assert.deepEqual(result.triggers.ordinary_doc_path_matches, [
                { path: 'CHANGELOG.md', pattern: 'CHANGELOG.md' }
            ]);
        });

        it('keeps security-sensitive markdown in docs-only scope while requiring security review', () => {
            const result = classifyChange({
                normalizedFiles: ['docs/security.md'],
                taskIntent: 'Update security support promise',
                changedLinesTotal: 4,
                additionsTotal: 4,
                deletionsTotal: 0,
                renameCount: 0,
                detectionSource: 'explicit_changed_files',
                classificationConfig: makeConfig(),
                reviewCapabilities: { ...defaultCapabilities, security: true }
            });

            assert.equal(result.scope_category, 'docs-only');
            assert.equal(result.required_reviews.code, false);
            assert.equal(result.required_reviews.security, true);
            assert.equal(result.required_reviews.test, false);
            assert.deepEqual(result.triggers.ordinary_doc_path_matched_files, []);
        });

        it('accepts a user-configured docs/plan.md ordinary doc path without code or test review', () => {
            const result = classifyChange({
                normalizedFiles: ['docs/plan.md'],
                taskIntent: 'Update planning note',
                changedLinesTotal: 6,
                additionsTotal: 5,
                deletionsTotal: 1,
                renameCount: 0,
                detectionSource: 'explicit_changed_files',
                classificationConfig: makeConfig({
                    ordinary_doc_paths: ['CHANGELOG.md', 'docs/plan.md']
                }),
                reviewCapabilities: { ...defaultCapabilities, test: true }
            });

            assert.equal(result.scope_category, 'docs-only');
            assert.equal(result.required_reviews.code, false);
            assert.equal(result.required_reviews.test, false);
            assert.deepEqual(result.triggers.ordinary_doc_path_matched_files, ['docs/plan.md']);
        });

        it('suppresses test review for safe ordinary docs under test-like paths', () => {
            const result = classifyChange({
                normalizedFiles: ['tests/plan.md'],
                taskIntent: 'Update test planning note',
                changedLinesTotal: 5,
                additionsTotal: 5,
                deletionsTotal: 0,
                renameCount: 0,
                detectionSource: 'explicit_changed_files',
                classificationConfig: makeConfig({
                    ordinary_doc_paths: ['tests/plan.md']
                }),
                reviewCapabilities: { ...defaultCapabilities, test: true }
            });

            assert.equal(result.scope_category, 'docs-only');
            assert.equal(result.triggers.test, false);
            assert.equal(result.required_reviews.test, false);
            assert.deepEqual(result.triggers.test_ordinary_doc_suppressed_files, ['tests/plan.md']);
        });

        it('keeps test review for unconfigured docs under test-like paths', () => {
            const result = classifyChange({
                normalizedFiles: ['tests/README.md'],
                taskIntent: 'Update test documentation',
                changedLinesTotal: 5,
                additionsTotal: 5,
                deletionsTotal: 0,
                renameCount: 0,
                detectionSource: 'explicit_changed_files',
                classificationConfig: makeConfig(),
                reviewCapabilities: { ...defaultCapabilities, test: true }
            });

            assert.equal(result.scope_category, 'docs-only');
            assert.equal(result.triggers.test, true);
            assert.equal(result.required_reviews.test, true);
            assert.deepEqual(result.triggers.ordinary_doc_path_matched_files, []);
            assert.deepEqual(result.triggers.test_ordinary_doc_suppressed_files, []);
        });

        it('classifies pure configured test-scope changes as test-only', () => {
            const result = classifyChange({
                normalizedFiles: ['tests/node/cli/commands/gates.test.ts'],
                taskIntent: 'Update test fixture expectations',
                changedLinesTotal: 8,
                additionsTotal: 5,
                deletionsTotal: 3,
                renameCount: 0,
                detectionSource: 'explicit_changed_files',
                classificationConfig: makeConfig(),
                reviewCapabilities: { ...defaultCapabilities, test: true }
            });

            assert.equal(result.scope_category, 'test-only');
            assert.equal(result.triggers.test, true);
            assert.equal(result.required_reviews.code, false);
            assert.equal(result.required_reviews.test, true);
            assert.ok(result.scope_category_reasons.includes('test_only_files=1'));
        });

        it('classifies configured test-scope changes under runtime roots as test-only', () => {
            const result = classifyChange({
                normalizedFiles: ['src/test/cart.test.ts', 'packages/orders/tests/order-flow.test.ts'],
                taskIntent: 'Update test fixture expectations',
                changedLinesTotal: 12,
                additionsTotal: 9,
                deletionsTotal: 3,
                renameCount: 0,
                detectionSource: 'explicit_changed_files',
                classificationConfig: makeConfig({
                    runtime_roots: ['src/', 'packages/']
                }),
                reviewCapabilities: { ...defaultCapabilities, test: true }
            });

            assert.equal(result.scope_category, 'test-only');
            assert.equal(result.triggers.test, true);
            assert.equal(result.required_reviews.code, false);
            assert.equal(result.required_reviews.test, true);
            assert.ok(result.scope_category_reasons.includes('test_only_files=2'));
        });

        it('keeps mixed source plus test changes on the code review path', () => {
            const result = classifyChange({
                normalizedFiles: ['src/app.ts', 'tests/app.test.ts'],
                taskIntent: 'Update runtime and coverage',
                changedLinesTotal: 24,
                additionsTotal: 18,
                deletionsTotal: 6,
                renameCount: 0,
                detectionSource: 'explicit_changed_files',
                classificationConfig: makeConfig(),
                reviewCapabilities: { ...defaultCapabilities, test: true }
            });

            assert.equal(result.scope_category, 'mixed');
            assert.equal(result.required_reviews.code, true);
            assert.equal(result.required_reviews.test, true);
        });

        it('honors configured nonstandard test roots without assuming a Node project layout', () => {
            const result = classifyChange({
                normalizedFiles: ['quality/regression/auth-flow.fixture.py'],
                taskIntent: 'Update regression fixture',
                changedLinesTotal: 6,
                additionsTotal: 4,
                deletionsTotal: 2,
                renameCount: 0,
                detectionSource: 'explicit_changed_files',
                classificationConfig: makeConfig({
                    test_trigger_regexes: ['(^|/)quality/regression/']
                }),
                reviewCapabilities: { ...defaultCapabilities, test: true }
            });

            assert.equal(result.scope_category, 'test-only');
            assert.equal(result.triggers.test, true);
            assert.equal(result.required_reviews.test, true);
            assert.equal(result.required_reviews.code, false);
        });

        it('keeps security review for sensitive paths under test scope', () => {
            const result = classifyChange({
                normalizedFiles: ['tests/security/auth-token.test.ts'],
                taskIntent: 'Update sensitive auth test coverage',
                changedLinesTotal: 12,
                additionsTotal: 8,
                deletionsTotal: 4,
                renameCount: 0,
                detectionSource: 'explicit_changed_files',
                classificationConfig: makeConfig(),
                reviewCapabilities: { ...defaultCapabilities, test: true }
            });

            assert.equal(result.scope_category, 'test-only');
            assert.equal(result.triggers.security, true);
            assert.equal(result.required_reviews.security, true);
            assert.equal(result.required_reviews.test, true);
        });

        it('triggers security review from sensitive runtime intent when path names are generic', () => {
            const sensitiveIntents = [
                'Handle public webhook OAuth token refresh',
                'Update OAuth2 provider handoff',
                'Encrypt credentials before callback ownership handoff',
                'Download Telegram Bot API files with secret-safe observability',
                'Redact provider token values from sanitized observability',
                'Record sanitized-observability for provider file-download failures'
            ];

            for (const taskIntent of sensitiveIntents) {
                const result = classifyChange({
                    normalizedFiles: ['src/integrations/telegram/update-flow.ts'],
                    taskIntent,
                    changedLinesTotal: 36,
                    additionsTotal: 24,
                    deletionsTotal: 12,
                    renameCount: 0,
                    detectionSource: 'explicit_changed_files',
                    classificationConfig: makeConfig(),
                    reviewCapabilities: defaultCapabilities
                });

                assert.equal(result.triggers.security, true, taskIntent);
                assert.equal(result.triggers.security_intent, true, taskIntent);
                assert.equal(result.required_reviews.security, true, taskIntent);
            }
        });

        it('triggers api review from public webhook and callback intent on generic runtime paths', () => {
            const apiIntents = [
                'Change public webhook callback response contract for Telegram Bot API file download',
                'Change provider file-download response contract'
            ];

            for (const taskIntent of apiIntents) {
                const result = classifyChange({
                    normalizedFiles: ['src/integrations/telegram/update-flow.ts'],
                    taskIntent,
                    changedLinesTotal: 34,
                    additionsTotal: 20,
                    deletionsTotal: 14,
                    renameCount: 0,
                    detectionSource: 'explicit_changed_files',
                    classificationConfig: makeConfig(),
                    reviewCapabilities: { ...defaultCapabilities, api: true }
                });

                assert.equal(result.triggers.api, true, taskIntent);
                assert.equal(result.triggers.api_intent, true, taskIntent);
                assert.equal(result.required_reviews.api, true, taskIntent);
            }
        });

        it('triggers api review for a standalone API intent without matching incidental substrings', () => {
            const apiResult = classifyChange({
                normalizedFiles: ['src/reports/profile-policy.ts'],
                taskIntent: 'Add guarded local UI policy API flow',
                changedLinesTotal: 34,
                additionsTotal: 20,
                deletionsTotal: 14,
                renameCount: 0,
                detectionSource: 'explicit_changed_files',
                classificationConfig: makeConfig(),
                reviewCapabilities: { ...defaultCapabilities, api: true }
            });
            const incidentalResult = classifyChange({
                normalizedFiles: ['src/reports/profile-policy.ts'],
                taskIntent: 'Adjust capitalization in the rapid preview flow',
                changedLinesTotal: 34,
                additionsTotal: 20,
                deletionsTotal: 14,
                renameCount: 0,
                detectionSource: 'explicit_changed_files',
                classificationConfig: makeConfig(),
                reviewCapabilities: { ...defaultCapabilities, api: true }
            });

            assert.equal(apiResult.triggers.api_intent, true);
            assert.equal(apiResult.required_reviews.api, true);
            assert.equal(incidentalResult.triggers.api_intent, false);
            assert.equal(incidentalResult.required_reviews.api, false);
        });

        it('suppresses api and performance domain reviews for pure test-only maintenance', () => {
            const result = classifyChange({
                normalizedFiles: [
                    'tests/api/routes.test.ts',
                    'tests/performance/latency.test.ts'
                ],
                taskIntent: 'Split large API and performance test suites',
                changedLinesTotal: 80,
                additionsTotal: 42,
                deletionsTotal: 38,
                renameCount: 0,
                detectionSource: 'explicit_changed_files',
                classificationConfig: makeConfig(),
                reviewCapabilities: { ...defaultCapabilities, api: true, performance: true, test: true }
            });

            assert.equal(result.scope_category, 'test-only');
            assert.equal(result.triggers.test, true);
            assert.equal(result.triggers.api, false);
            assert.equal(result.triggers.performance, false);
            assert.equal(result.required_reviews.test, true);
            assert.equal(result.required_reviews.api, false);
            assert.equal(result.required_reviews.performance, false);
            assert.deepEqual(result.triggers.api_path_changed_files, ['tests/api/routes.test.ts']);
            assert.deepEqual(result.triggers.api_test_only_suppressed_files, ['tests/api/routes.test.ts']);
            assert.deepEqual(result.triggers.performance_path_changed_files, ['tests/performance/latency.test.ts']);
            assert.deepEqual(result.triggers.performance_test_only_suppressed_files, ['tests/performance/latency.test.ts']);
        });

        it('suppresses api intent for db-only test paths without runtime implementation scope', () => {
            const result = classifyChange({
                normalizedFiles: ['tests/db/callback-contract.test.ts'],
                taskIntent: 'Cover callback API route behavior for repository migration tests',
                changedLinesTotal: 48,
                additionsTotal: 30,
                deletionsTotal: 18,
                renameCount: 0,
                detectionSource: 'explicit_changed_files',
                classificationConfig: makeConfig(),
                reviewCapabilities: { ...defaultCapabilities, api: true, test: true }
            });

            assert.equal(result.scope_category, 'test-only');
            assert.equal(result.triggers.test, true);
            assert.equal(result.triggers.api, false);
            assert.equal(result.triggers.api_intent, false);
            assert.equal(result.required_reviews.api, false);
            assert.equal(result.required_reviews.test, true);
        });

        it('suppresses performance heuristic for large api-shaped test-only maintenance', () => {
            const result = classifyChange({
                normalizedFiles: ['tests/api/RequestContract.test.ts'],
                taskIntent: 'Split large API contract test suite',
                changedLinesTotal: 180,
                additionsTotal: 92,
                deletionsTotal: 88,
                renameCount: 0,
                detectionSource: 'explicit_changed_files',
                classificationConfig: makeConfig(),
                reviewCapabilities: { ...defaultCapabilities, api: true, performance: true, test: true }
            });

            assert.equal(result.scope_category, 'test-only');
            assert.equal(result.triggers.api, false);
            assert.equal(result.triggers.performance, false);
            assert.equal(result.required_reviews.api, false);
            assert.equal(result.required_reviews.performance, false);
            assert.equal(result.required_reviews.test, true);
            assert.deepEqual(result.triggers.api_test_only_suppressed_files, ['tests/api/RequestContract.test.ts']);
            assert.equal(result.triggers.performance_test_only_suppressed_heuristic, true);
        });

        it('keeps protected control-plane documentation as docs-only without ordinary-doc trust', () => {
            const result = classifyChange({
                normalizedFiles: ['garda-agent-orchestrator/live/docs/agent-rules/00-core.md'],
                taskIntent: 'Update protected rule docs',
                changedLinesTotal: 8,
                additionsTotal: 6,
                deletionsTotal: 2,
                renameCount: 0,
                detectionSource: 'explicit_changed_files',
                classificationConfig: makeConfig({
                    ordinary_doc_paths: ['garda-agent-orchestrator/live/docs/agent-rules/**']
                }),
                reviewCapabilities: defaultCapabilities
            });

            assert.equal(result.scope_category, 'docs-only');
            assert.equal(result.triggers.protected_control_plane_changed, true);
            assert.equal(result.triggers.protected_control_plane_docs_only, true);
            assert.deepEqual(result.triggers.ordinary_doc_path_matched_files, []);
        });

        it('keeps root protected agent entrypoints audit-only instead of protected docs-only', () => {
            const result = classifyChange({
                normalizedFiles: ['AGENTS.md'],
                taskIntent: 'Update root agent entrypoint',
                changedLinesTotal: 8,
                additionsTotal: 6,
                deletionsTotal: 2,
                renameCount: 0,
                detectionSource: 'explicit_changed_files',
                classificationConfig: makeConfig(),
                reviewCapabilities: defaultCapabilities
            });

            assert.equal(result.scope_category, 'audit-only');
            assert.equal(result.triggers.protected_control_plane_changed, true);
            assert.equal(result.triggers.protected_control_plane_docs_only, false);
        });

        it('rejects sensitive review trigger paths as ordinary docs even when configured', () => {
            const result = classifyChange({
                normalizedFiles: [
                    'requirements.txt',
                    'docs/security.md',
                    'docs/graphql.md',
                    'database/README.md'
                ],
                taskIntent: 'Update dependency, security, API, and database notes',
                changedLinesTotal: 12,
                additionsTotal: 8,
                deletionsTotal: 4,
                renameCount: 0,
                detectionSource: 'explicit_changed_files',
                classificationConfig: makeConfig({
                    ordinary_doc_paths: [
                        'requirements.txt',
                        'docs/security.md',
                        'docs/graphql.md',
                        'database/README.md'
                    ]
                }),
                reviewCapabilities: {
                    ...defaultCapabilities,
                    db: true,
                    security: true,
                    api: true,
                    dependency: true
                }
            });

            assert.equal(result.triggers.db, true);
            assert.equal(result.triggers.security, true);
            assert.equal(result.triggers.api, true);
            assert.equal(result.triggers.dependency, true);
            assert.equal(result.required_reviews.db, true);
            assert.equal(result.required_reviews.security, true);
            assert.equal(result.required_reviews.api, true);
            assert.equal(result.required_reviews.dependency, true);
            assert.deepEqual(result.triggers.ordinary_doc_path_matched_files, []);
        });

        it('keeps mixed ordinary docs plus runtime source changes on the code review path', () => {
            const result = classifyChange({
                normalizedFiles: ['docs/plan.md', 'src/app.ts'],
                taskIntent: 'Update planning note and runtime behavior',
                changedLinesTotal: 30,
                additionsTotal: 20,
                deletionsTotal: 10,
                renameCount: 0,
                detectionSource: 'explicit_changed_files',
                classificationConfig: makeConfig({
                    ordinary_doc_paths: ['docs/plan.md']
                }),
                reviewCapabilities: defaultCapabilities
            });

            assert.equal(result.scope_category, 'mixed');
            assert.equal(result.required_reviews.code, true);
            assert.deepEqual(result.triggers.ordinary_doc_path_matched_files, ['docs/plan.md']);
        });

        it('returns FULL_PATH for large backend change', () => {
            const result = classifyChange({
                normalizedFiles: ['src/service/UserService.java', 'src/model/User.java', 'src/controller/UserController.java'],
                taskIntent: 'Add user management',
                changedLinesTotal: 200,
                additionsTotal: 150,
                deletionsTotal: 50,
                renameCount: 0,
                detectionSource: 'git_auto',
                classificationConfig: makeConfig(),
                reviewCapabilities: defaultCapabilities
            });
            assert.equal(result.mode, 'FULL_PATH');
            assert.equal(result.required_reviews.code, true);
        });

        it('triggers db review for migration files', () => {
            const result = classifyChange({
                normalizedFiles: ['src/db/migrations/001_init.sql'],
                taskIntent: 'DB migration',
                changedLinesTotal: 50,
                additionsTotal: 50,
                deletionsTotal: 0,
                renameCount: 0,
                detectionSource: 'git_auto',
                classificationConfig: makeConfig(),
                reviewCapabilities: defaultCapabilities
            });
            assert.equal(result.triggers.db, true);
            assert.equal(result.required_reviews.db, true);
        });

        it('triggers db review for database config files matched by ambient framework words', () => {
            const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-db-config-scope-'));
            fs.mkdirSync(path.join(repoRoot, 'prisma'), { recursive: true });
            fs.writeFileSync(path.join(repoRoot, 'prisma', 'schema.prisma'), 'datasource db { provider = "postgresql" }\n', 'utf8');

            try {
                const result = classifyChange({
                    normalizedFiles: ['prisma/schema.prisma'],
                    repoRoot,
                    taskIntent: 'Update Prisma datasource config',
                    changedLinesTotal: 8,
                    additionsTotal: 5,
                    deletionsTotal: 3,
                    renameCount: 0,
                    detectionSource: 'git_auto',
                    classificationConfig: getClassificationConfig(repoRoot),
                    reviewCapabilities: defaultCapabilities
                });

                assert.equal(result.triggers.db, true);
                assert.equal(result.required_reviews.db, true);
                assert.deepEqual(result.triggers.db_strong_changed_files, ['prisma/schema.prisma']);
                assert.deepEqual(result.triggers.db_ambient_signal_files, []);
                assert.equal(result.triggers.db_downgrade_reason, null);
            } finally {
                fs.rmSync(repoRoot, { recursive: true, force: true });
            }
        });

        it('downgrades ambient project database evidence for docs and ops shell changes', () => {
            const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-ambient-db-scope-'));
            fs.mkdirSync(path.join(repoRoot, 'docs'), { recursive: true });
            fs.mkdirSync(path.join(repoRoot, 'ops'), { recursive: true });
            fs.writeFileSync(path.join(repoRoot, 'package.json'), JSON.stringify({
                dependencies: {
                    pg: '^8.0.0'
                }
            }), 'utf8');
            fs.writeFileSync(path.join(repoRoot, 'flyway.conf'), 'url=jdbc:postgresql://localhost/app\n', 'utf8');
            fs.writeFileSync(path.join(repoRoot, 'docs', 'flyway-runbook.md'), '# Flyway runbook\n', 'utf8');
            fs.writeFileSync(path.join(repoRoot, 'ops', 'flyway-backup.sh'), 'echo backup\n', 'utf8');

            try {
                const docsResult = classifyChange({
                    normalizedFiles: ['docs/flyway-runbook.md'],
                    repoRoot,
                    taskIntent: 'Document database operations',
                    changedLinesTotal: 6,
                    additionsTotal: 4,
                    deletionsTotal: 2,
                    renameCount: 0,
                    detectionSource: 'git_auto',
                    classificationConfig: getClassificationConfig(repoRoot),
                    reviewCapabilities: defaultCapabilities
                });
                const shellResult = classifyChange({
                    normalizedFiles: ['ops/flyway-backup.sh'],
                    repoRoot,
                    taskIntent: 'Update shell-only backup wrapper',
                    changedLinesTotal: 6,
                    additionsTotal: 4,
                    deletionsTotal: 2,
                    renameCount: 0,
                    detectionSource: 'git_auto',
                    classificationConfig: getClassificationConfig(repoRoot),
                    reviewCapabilities: defaultCapabilities
                });

                for (const result of [docsResult, shellResult]) {
                    assert.equal(result.triggers.db, false);
                    assert.equal(result.required_reviews.db, false);
                    assert.deepEqual(result.triggers.db_strong_changed_files, []);
                    assert.deepEqual(result.triggers.db_weak_signal_files, []);
                    assert.ok((result.triggers.db_project_evidence as string[]).includes('package:pg'));
                    assert.ok((result.triggers.db_project_evidence as string[]).includes('flyway.conf'));
                    assert.equal(result.triggers.db_downgrade_reason, 'ambient_project_db_evidence_with_non_db_changed_scope');
                }
                assert.deepEqual(docsResult.triggers.db_ambient_signal_files, ['docs/flyway-runbook.md']);
                assert.deepEqual(shellResult.triggers.db_ambient_signal_files, ['ops/flyway-backup.sh']);
            } finally {
                fs.rmSync(repoRoot, { recursive: true, force: true });
            }
        });

        it('does not trigger db review from misleading migration wording without database evidence', () => {
            const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-no-db-scope-'));
            fs.mkdirSync(path.join(repoRoot, 'src', 'lifecycle'), { recursive: true });
            fs.writeFileSync(path.join(repoRoot, 'package.json'), JSON.stringify({ name: 'no-db-project' }), 'utf8');
            fs.writeFileSync(path.join(repoRoot, 'src', 'lifecycle', 'contract-migrations.ts'), 'export const migrateContracts = true;\n', 'utf8');

            try {
                const result = classifyChange({
                    normalizedFiles: ['src/lifecycle/contract-migrations.ts'],
                    repoRoot,
                    taskIntent: 'Update contract migration wording',
                    changedLinesTotal: 12,
                    additionsTotal: 8,
                    deletionsTotal: 4,
                    renameCount: 0,
                    detectionSource: 'git_auto',
                    classificationConfig: getClassificationConfig(repoRoot),
                    reviewCapabilities: defaultCapabilities
                });

                assert.equal(result.triggers.db, false);
                assert.equal(result.required_reviews.db, false);
                assert.deepEqual(result.triggers.db_strong_changed_files, []);
                assert.deepEqual(result.triggers.db_weak_signal_files, ['src/lifecycle/contract-migrations.ts']);
                assert.deepEqual(result.triggers.db_project_evidence, []);
            } finally {
                fs.rmSync(repoRoot, { recursive: true, force: true });
            }
        });

        it('triggers db review for weak migration wording when the project has database evidence', () => {
            const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-db-scope-'));
            fs.mkdirSync(path.join(repoRoot, 'src', 'lifecycle'), { recursive: true });
            fs.mkdirSync(path.join(repoRoot, 'prisma'), { recursive: true });
            fs.writeFileSync(path.join(repoRoot, 'package.json'), JSON.stringify({ name: 'db-project' }), 'utf8');
            fs.writeFileSync(path.join(repoRoot, 'prisma', 'schema.prisma'), 'datasource db { provider = "postgresql" url = env("DATABASE_URL") }\n', 'utf8');
            fs.writeFileSync(path.join(repoRoot, 'src', 'lifecycle', 'contract-migrations.ts'), 'export const migrateContracts = true;\n', 'utf8');

            try {
                const result = classifyChange({
                    normalizedFiles: ['src/lifecycle/contract-migrations.ts'],
                    repoRoot,
                    taskIntent: 'Update contract migration code in a database-backed project',
                    changedLinesTotal: 12,
                    additionsTotal: 8,
                    deletionsTotal: 4,
                    renameCount: 0,
                    detectionSource: 'git_auto',
                    classificationConfig: getClassificationConfig(repoRoot),
                    reviewCapabilities: defaultCapabilities
                });

                assert.equal(result.triggers.db, true);
                assert.equal(result.required_reviews.db, true);
                assert.deepEqual(result.triggers.db_weak_signal_files, ['src/lifecycle/contract-migrations.ts']);
                assert.ok((result.triggers.db_project_evidence as string[]).includes('prisma/schema.prisma'));
            } finally {
                fs.rmSync(repoRoot, { recursive: true, force: true });
            }
        });

        it('detects database evidence from the changed file package scope in monorepos', () => {
            const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-monorepo-db-scope-'));
            fs.mkdirSync(path.join(repoRoot, 'packages', 'api', 'src'), { recursive: true });
            fs.writeFileSync(path.join(repoRoot, 'package.json'), JSON.stringify({ name: 'root-without-db' }), 'utf8');
            fs.writeFileSync(
                path.join(repoRoot, 'packages', 'api', 'package.json'),
                JSON.stringify({ name: 'api', dependencies: { pg: '^8.0.0' } }),
                'utf8'
            );
            fs.writeFileSync(path.join(repoRoot, 'packages', 'api', 'src', 'UserRepository.ts'), 'export const repository = true;\n', 'utf8');

            try {
                const result = classifyChange({
                    normalizedFiles: ['packages/api/src/UserRepository.ts'],
                    repoRoot,
                    taskIntent: 'Update repository behavior in a database-backed package',
                    changedLinesTotal: 12,
                    additionsTotal: 8,
                    deletionsTotal: 4,
                    renameCount: 0,
                    detectionSource: 'git_auto',
                    classificationConfig: getClassificationConfig(repoRoot),
                    reviewCapabilities: defaultCapabilities
                });

                assert.equal(result.triggers.db, true);
                assert.equal(result.required_reviews.db, true);
                assert.deepEqual(result.triggers.db_weak_signal_files, ['packages/api/src/UserRepository.ts']);
                assert.ok((result.triggers.db_project_evidence as string[]).includes('packages/api/package:pg'));
            } finally {
                fs.rmSync(repoRoot, { recursive: true, force: true });
            }
        });

        it('keeps custom db trigger patterns authoritative as strong changed-scope signals', () => {
            const result = classifyChange({
                normalizedFiles: ['src/lifecycle/contract-migrations.ts'],
                taskIntent: 'Update a project-specific DB contract migration',
                changedLinesTotal: 12,
                additionsTotal: 8,
                deletionsTotal: 4,
                renameCount: 0,
                detectionSource: 'git_auto',
                classificationConfig: makeConfig({
                    db_trigger_regexes: ['contract-migrations\\.ts$']
                }),
                reviewCapabilities: defaultCapabilities
            });

            assert.equal(result.triggers.db, true);
            assert.equal(result.required_reviews.db, true);
            assert.deepEqual(result.triggers.db_strong_changed_files, ['src/lifecycle/contract-migrations.ts']);
            assert.deepEqual(result.triggers.db_project_evidence, []);
        });

        it('does not force hardcoded strong db paths when configured db triggers are narrowed', () => {
            const result = classifyChange({
                normalizedFiles: ['src/schema/generated.ts', 'migrations/001.sql'],
                taskIntent: 'Update non-database schema artifacts in a project with narrowed DB triggers',
                changedLinesTotal: 12,
                additionsTotal: 8,
                deletionsTotal: 4,
                renameCount: 0,
                detectionSource: 'git_auto',
                classificationConfig: makeConfig({
                    db_trigger_regexes: []
                }),
                reviewCapabilities: defaultCapabilities
            });

            assert.equal(result.triggers.db, false);
            assert.equal(result.required_reviews.db, false);
            assert.deepEqual(result.triggers.db_strong_changed_files, []);
            assert.deepEqual(result.triggers.db_weak_signal_files, []);
        });

        it('triggers security review for auth files', () => {
            const result = classifyChange({
                normalizedFiles: ['src/auth/JwtProvider.ts'],
                taskIntent: 'Fix auth',
                changedLinesTotal: 20,
                additionsTotal: 15,
                deletionsTotal: 5,
                renameCount: 0,
                detectionSource: 'git_auto',
                classificationConfig: makeConfig(),
                reviewCapabilities: defaultCapabilities
            });
            assert.equal(result.triggers.security, true);
            assert.equal(result.required_reviews.security, true);
        });

        it('matches security triggers case-insensitively for java config paths', () => {
            const result = classifyChange({
                normalizedFiles: ['api-gateway/src/main/java/com/acme/security/SecurityConfig.java'],
                taskIntent: 'Tighten security rules',
                changedLinesTotal: 18,
                additionsTotal: 12,
                deletionsTotal: 6,
                renameCount: 0,
                detectionSource: 'git_auto',
                classificationConfig: makeConfig(),
                reviewCapabilities: defaultCapabilities
            });
            assert.equal(result.triggers.security, true);
            assert.equal(result.required_reviews.security, true);
        });

        it('allows small frontend package state updates to stay on fast path', () => {
            const result = classifyChange({
                normalizedFiles: ['store-frontend/src/store/cart-store.ts'],
                taskIntent: 'Adjust cart store labels',
                changedLinesTotal: 12,
                additionsTotal: 8,
                deletionsTotal: 4,
                renameCount: 0,
                detectionSource: 'explicit_changed_files',
                classificationConfig: makeConfig(),
                reviewCapabilities: defaultCapabilities
            });
            assert.equal(result.mode, 'FAST_PATH');
            assert.equal(result.triggers.fast_path_eligible, true);
            assert.equal(result.required_reviews.code, false);
        });

        it('triggers dependency review for package.json', () => {
            const result = classifyChange({
                normalizedFiles: ['package.json'],
                taskIntent: 'Update deps',
                changedLinesTotal: 5,
                additionsTotal: 3,
                deletionsTotal: 2,
                renameCount: 0,
                detectionSource: 'git_auto',
                classificationConfig: makeConfig(),
                reviewCapabilities: { ...defaultCapabilities, dependency: true }
            });
            assert.equal(result.triggers.dependency, true);
            assert.equal(result.required_reviews.dependency, true);
        });

        it('disables api review if capability is false', () => {
            const result = classifyChange({
                normalizedFiles: ['src/controllers/UserController.ts'],
                taskIntent: '',
                changedLinesTotal: 30,
                additionsTotal: 20,
                deletionsTotal: 10,
                renameCount: 0,
                detectionSource: 'git_auto',
                classificationConfig: makeConfig(),
                reviewCapabilities: { ...defaultCapabilities, api: false }
            });
            assert.equal(result.triggers.api, true);
            assert.equal(result.required_reviews.api, false);
        });

        it('returns empty reviews for no changed files', () => {
            const result = classifyChange({
                normalizedFiles: [],
                taskIntent: '',
                changedLinesTotal: 0,
                additionsTotal: 0,
                deletionsTotal: 0,
                renameCount: 0,
                detectionSource: 'git_auto',
                classificationConfig: makeConfig(),
                reviewCapabilities: defaultCapabilities
            });
            assert.equal(result.mode, 'FULL_PATH');
            assert.equal(result.required_reviews.code, false);
            assert.equal(result.changed_files.length, 0);
            assert.equal(result.zero_diff_guard.zero_diff_detected, true);
            assert.equal(result.zero_diff_guard.status, 'BASELINE_ONLY');
            assert.equal(result.zero_diff_guard.completion_requires_audited_no_op, true);
        });

        it('preserves changed_files in output', () => {
            const files = ['src/a.ts', 'src/b.ts'];
            const result = classifyChange({
                normalizedFiles: files,
                taskIntent: '',
                changedLinesTotal: 20,
                additionsTotal: 10,
                deletionsTotal: 10,
                renameCount: 0,
                detectionSource: 'explicit_changed_files',
                classificationConfig: makeConfig(),
                reviewCapabilities: defaultCapabilities
            });
            assert.deepEqual(result.changed_files, files);
            assert.equal(result.detection_source, 'explicit_changed_files');
        });

        it('ignores generated runtime artifacts while keeping test-only review routing', () => {
            const generatedRuntimeFiles = [
                'garda-agent-orchestrator/runtime/plans/T-559-3.md',
                'garda-agent-orchestrator/runtime/reports/garda-report.html',
                'garda-agent-orchestrator/runtime/task-events/T-504.jsonl',
                'garda-agent-orchestrator/runtime/.runtime-mutation-generation.anchor.json',
                'garda-agent-orchestrator/runtime/.runtime-mutation-generation/head.json',
                'garda-agent-orchestrator/runtime/.runtime-mutation-generation/state-a.json',
                'garda-agent-orchestrator/runtime/.runtime-mutation-generation/state-b.json',
                'garda-agent-orchestrator/runtime/.runtime-mutation-generation.lock/owner.json',
                'Z:/missing/root/runtime/task-events/all-tasks.jsonl',
                'mnt/wsl/projects/missing/runtime/task-events/T-504.jsonl'
            ];
            const result = classifyChange({
                normalizedFiles: [
                    'tests/node/cli/commands/gates-preflight.test.ts',
                    ...generatedRuntimeFiles
                ],
                taskIntent: 'Keep generated task events out of review routing',
                changedLinesTotal: 30,
                additionsTotal: 25,
                deletionsTotal: 5,
                renameCount: 0,
                detectionSource: 'explicit_changed_files',
                classificationConfig: makeConfig(),
                reviewCapabilities: { ...defaultCapabilities, test: true }
            });

            assert.deepEqual(result.changed_files, ['tests/node/cli/commands/gates-preflight.test.ts']);
            assert.equal(result.scope_category, 'test-only');
            assert.equal(result.triggers.test, true);
            assert.equal(result.required_reviews.code, false);
            assert.equal(result.required_reviews.test, true);
            assert.deepEqual(result.triggers.ignored_generated_runtime_files, generatedRuntimeFiles);
            assert.equal(result.metrics.ignored_generated_runtime_files_count, generatedRuntimeFiles.length);
            assert.match(result.workspace_hygiene_warnings[0], /Ignored 10 generated runtime\/control-plane artifact/);
        });

        it('keeps real code changes as code review even with generated review artifacts', () => {
            const result = classifyChange({
                normalizedFiles: [
                    'src/gates/classify-change.ts',
                    'garda-agent-orchestrator/runtime/reviews/T-504-code.md'
                ],
                taskIntent: 'Patch classifier source',
                changedLinesTotal: 45,
                additionsTotal: 35,
                deletionsTotal: 10,
                renameCount: 0,
                detectionSource: 'explicit_changed_files',
                classificationConfig: makeConfig(),
                reviewCapabilities: { ...defaultCapabilities, test: true }
            });

            assert.deepEqual(result.changed_files, ['src/gates/classify-change.ts']);
            assert.equal(result.scope_category, 'code');
            assert.equal(result.required_reviews.code, true);
            assert.equal(result.required_reviews.test, false);
        });

        it('keeps real code plus test changes mixed after generated artifacts are ignored', () => {
            const result = classifyChange({
                normalizedFiles: [
                    'src/gates/classify-change.ts',
                    'tests/node/gates/classify-change.test.ts',
                    'runtime/task-events/T-504-preflight.jsonl'
                ],
                taskIntent: 'Patch classifier source and tests',
                changedLinesTotal: 55,
                additionsTotal: 45,
                deletionsTotal: 10,
                renameCount: 0,
                detectionSource: 'explicit_changed_files',
                classificationConfig: makeConfig(),
                reviewCapabilities: { ...defaultCapabilities, test: true }
            });

            assert.deepEqual(result.changed_files, [
                'src/gates/classify-change.ts',
                'tests/node/gates/classify-change.test.ts'
            ]);
            assert.equal(result.scope_category, 'mixed');
            assert.equal(result.required_reviews.code, true);
            assert.equal(result.required_reviews.test, true);
        });

        it('does not treat ordinary project bin/dist/src-cli paths as protected control-plane in a normal workspace', () => {
            const result = classifyChange({
                normalizedFiles: ['src/cli/app.ts', 'dist/app.js', 'bin/run.js'],
                taskIntent: 'Update app runtime',
                changedLinesTotal: 25,
                additionsTotal: 20,
                deletionsTotal: 5,
                renameCount: 0,
                detectionSource: 'explicit_changed_files',
                classificationConfig: makeConfig(),
                reviewCapabilities: defaultCapabilities
            });

            assert.equal(result.triggers.protected_control_plane_changed, false);
            assert.deepEqual(result.triggers.changed_protected_files, []);
        });

        it('treats deployed bundle runtime paths as protected control-plane', () => {
            const result = classifyChange({
                normalizedFiles: ['garda-agent-orchestrator/src/cli/main.ts'],
                taskIntent: 'Patch orchestrator runtime',
                changedLinesTotal: 12,
                additionsTotal: 9,
                deletionsTotal: 3,
                renameCount: 0,
                detectionSource: 'explicit_changed_files',
                classificationConfig: makeConfig(),
                reviewCapabilities: defaultCapabilities
            });

            assert.equal(result.triggers.protected_control_plane_changed, true);
            assert.equal(result.triggers.protected_control_plane_docs_only, false);
            assert.deepEqual(result.triggers.changed_protected_files, ['garda-agent-orchestrator/src/cli/main.ts']);
        });

        it('treats root-level agent control-plane files as protected control-plane', () => {
            const result = classifyChange({
                normalizedFiles: ['AGENTS.md', '.github/agents/orchestrator.md'],
                taskIntent: 'Patch agent control plane',
                changedLinesTotal: 8,
                additionsTotal: 6,
                deletionsTotal: 2,
                renameCount: 0,
                detectionSource: 'explicit_changed_files',
                classificationConfig: makeConfig(),
                reviewCapabilities: defaultCapabilities
            });

            assert.equal(result.triggers.protected_control_plane_changed, true);
            assert.deepEqual(result.triggers.changed_protected_files, ['AGENTS.md', '.github/agents/orchestrator.md']);
        });

        it('treats root-level orchestrator source paths as protected only in the self-hosted source checkout', () => {
            const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-protected-roots-'));
            fs.writeFileSync(path.join(repoRoot, 'package.json'), JSON.stringify({ name: 'garda-agent-orchestrator' }), 'utf8');

            try {
                const result = classifyChange({
                    normalizedFiles: ['src/cli/main.ts'],
                    taskIntent: 'Patch orchestrator source',
                    changedLinesTotal: 12,
                    additionsTotal: 9,
                    deletionsTotal: 3,
                    renameCount: 0,
                    detectionSource: 'explicit_changed_files',
                    classificationConfig: getClassificationConfig(repoRoot),
                    reviewCapabilities: defaultCapabilities
                });

                assert.equal(result.triggers.protected_control_plane_changed, true);
                assert.deepEqual(result.triggers.changed_protected_files, ['src/cli/main.ts']);
            } finally {
                fs.rmSync(repoRoot, { recursive: true, force: true });
            }
        });
    });
});


describe('classifyScopeCategory', () => {
    const codeLikeRegexes = ['\\.(ts|tsx|js|jsx|java|py|go)$'];
    const runtimeRoots = ['src/', 'app/', 'packages/'];

    it('classifies empty file list as empty', () => {
        const result = classifyScopeCategory([], codeLikeRegexes, runtimeRoots);
        assert.equal(result.category, 'empty');
    });

    it('classifies runtime code files as code', () => {
        const result = classifyScopeCategory(['src/main.ts', 'src/utils.ts'], codeLikeRegexes, runtimeRoots);
        assert.equal(result.category, 'code');
    });

    it('classifies doc-only changes as docs-only', () => {
        const result = classifyScopeCategory(['README.md', 'docs/guide.md'], codeLikeRegexes, runtimeRoots);
        assert.equal(result.category, 'docs-only');
    });

    it('classifies configured test paths as test-only', () => {
        const result = classifyScopeCategory(
            ['quality/regression/cart-flow.fixture.py'],
            codeLikeRegexes,
            runtimeRoots,
            { testTriggerRegexes: ['(^|/)quality/regression/'] }
        );
        assert.equal(result.category, 'test-only');
        assert.ok(result.reasons.includes('test_only_files=1'));
    });

    it('classifies configured test paths inside runtime roots as test-only', () => {
        const result = classifyScopeCategory(
            ['src/test/cart.test.ts', 'packages/orders/tests/order-flow.test.ts'],
            codeLikeRegexes,
            runtimeRoots,
            { testTriggerRegexes: ['(^|/)src/test/', '(^|/)(tests?)/', '\\.(spec|test)\\.(ts|tsx|js|jsx)$'] }
        );
        assert.equal(result.category, 'test-only');
        assert.ok(result.reasons.includes('test_only_files=2'));
    });

    it('classifies config-only changes as config-only', () => {
        const result = classifyScopeCategory(['tsconfig.json', '.editorconfig'], codeLikeRegexes, runtimeRoots);
        assert.equal(result.category, 'config-only');
    });

    it('classifies orchestrator control-plane files as audit-only', () => {
        const result = classifyScopeCategory(
            ['TASK.md', 'garda-agent-orchestrator/runtime/reviews/T-001-preflight.json'],
            codeLikeRegexes,
            runtimeRoots
        );
        assert.equal(result.category, 'audit-only');
    });

    it('classifies protected runtime source files as code before audit-only', () => {
        const result = classifyScopeCategory(
            ['src/gates/next-step.ts'],
            codeLikeRegexes,
            runtimeRoots,
            { protectedControlPlaneRoots: ['src/gates/'] }
        );
        assert.equal(result.category, 'code');
        assert.ok(result.reasons.includes('code_files=1'));
    });

    it('classifies protected runtime source plus tests as mixed', () => {
        const result = classifyScopeCategory(
            ['src/gates/next-step.ts', 'tests/node/gates/next-step.test.ts'],
            codeLikeRegexes,
            runtimeRoots,
            {
                protectedControlPlaneRoots: ['src/gates/'],
                testTriggerRegexes: ['(^|/)(tests?)/', '\\.(spec|test)\\.(ts|tsx|js|jsx)$']
            }
        );
        assert.equal(result.category, 'mixed');
        assert.ok(result.reasons.includes('code=1'));
        assert.ok(result.reasons.includes('tests=1'));
    });

    it('classifies mixed code+docs as mixed', () => {
        const result = classifyScopeCategory(['src/main.ts', 'README.md'], codeLikeRegexes, runtimeRoots);
        assert.equal(result.category, 'mixed');
    });

    it('classifies code+config as mixed', () => {
        const result = classifyScopeCategory(['src/main.ts', 'tsconfig.json'], codeLikeRegexes, runtimeRoots);
        assert.equal(result.category, 'mixed');
    });

    it('prevents docs+config from granting docs-only policy', () => {
        const result = classifyScopeCategory(['README.md', 'tsconfig.json'], codeLikeRegexes, runtimeRoots);
        assert.equal(result.category, 'mixed');
        assert.ok(result.reasons.includes('mixed_non_code'));
    });

    it('classifies CHANGELOG.md as docs-only', () => {
        const result = classifyScopeCategory(['CHANGELOG.md'], codeLikeRegexes, runtimeRoots);
        assert.equal(result.category, 'docs-only');
    });

    it('classifies unknown file types under runtime roots as code (safety default)', () => {
        const result = classifyScopeCategory(['src/data.bin'], codeLikeRegexes, runtimeRoots);
        assert.equal(result.category, 'code');
    });

    it('classifyChange output includes scope_category', () => {
        const result = classifyChange({
            normalizedFiles: ['src/main.ts'],
            taskIntent: 'refactor',
            changedLinesTotal: 10,
            classificationConfig: makeConfig(),
            reviewCapabilities: defaultCapabilities
        });
        assert.ok('scope_category' in result);
        assert.ok('scope_category_reasons' in result);
        assert.equal(result.scope_category, 'code');
    });

    it('classifyChange: docs-only files produce docs-only scope', () => {
        const result = classifyChange({
            normalizedFiles: ['README.md', 'docs/guide.md'],
            taskIntent: 'update docs',
            changedLinesTotal: 20,
            classificationConfig: makeConfig(),
            reviewCapabilities: defaultCapabilities
        });
        assert.equal(result.scope_category, 'docs-only');
    });
});
