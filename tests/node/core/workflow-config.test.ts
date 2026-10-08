import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    buildDefaultWorkflowConfig,
    isExactLegacyReviewCycleGuardGeneratedDefault,
    mergeWorkflowConfigWithTemplate,
    readWorkflowConfigForMerge,
    syncWorkflowConfigWithTemplate
} from '../../../src/core/workflow-config';

function mkTmpBundle(): string {
    const bundleRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-workflow-config-'));
    fs.mkdirSync(path.join(bundleRoot, 'template', 'config'), { recursive: true });
    fs.mkdirSync(path.join(bundleRoot, 'live', 'config'), { recursive: true });
    return bundleRoot;
}

function captureStderr(callback: () => void): string {
    const originalWrite = process.stderr.write;
    let output = '';
    (process.stderr as unknown as { write: (...args: unknown[]) => boolean }).write = function (chunk: unknown): boolean {
        output += String(chunk);
        return true;
    };
    try {
        callback();
    } finally {
        (process.stderr as unknown as { write: typeof process.stderr.write }).write = originalWrite;
    }
    return output;
}

describe('existing workflow configuration preservation', { concurrency: false }, () => {
    for (const original of ['{ "private_fixture": "retained-marker"', 'null', '[]', 'true']) {
        it(`rejects existing invalid input ${original} without replacing its bytes`, () => {
            const bundleRoot = mkTmpBundle();
            const configPath = path.join(bundleRoot, 'live', 'config', 'workflow-config.json');
            try {
                fs.writeFileSync(configPath, original);
                assert.throws(() => syncWorkflowConfigWithTemplate(bundleRoot), (error: unknown) => {
                    assert.ok(error instanceof Error);
                    assert.match(error.message, /existing.*workflow.config|workflow.config.*existing/i);
                    assert.equal(error.message.includes('retained-marker'), false);
                    return true;
                });
                assert.equal(fs.readFileSync(configPath, 'utf8'), original);
            } finally {
                fs.rmSync(bundleRoot, { recursive: true, force: true });
            }
        });
    }

    it('retains missing-file defaults and valid empty-object merging', () => {
        const bundleRoot = mkTmpBundle();
        const configPath = path.join(bundleRoot, 'live', 'config', 'workflow-config.json');
        try {
            assert.deepEqual(readWorkflowConfigForMerge(configPath), { status: 'missing', config: null });
            const fresh = syncWorkflowConfigWithTemplate(bundleRoot);
            assert.deepEqual(JSON.parse(fs.readFileSync(configPath, 'utf8')), fresh);
            fs.writeFileSync(configPath, '{}');
            const merged = syncWorkflowConfigWithTemplate(bundleRoot);
            assert.ok(Object.hasOwn(merged, 'compile_gate'));
        } finally {
            fs.rmSync(bundleRoot, { recursive: true, force: true });
        }
    });

    it('does not classify an inaccessible existing path as missing', (t) => {
        const bundleRoot = mkTmpBundle();
        const configPath = path.join(bundleRoot, 'live', 'config', 'workflow-config.json');
        const mutableFs = require('node:fs') as typeof fs;
        const originalExists = mutableFs.existsSync;
        const originalLstat = mutableFs.lstatSync;
        const unavailable = Object.assign(new Error('fixture access denied'), { code: 'EACCES' });
        fs.writeFileSync(configPath, '{"retained":true}');
        const existsMock = t.mock.method(mutableFs, 'existsSync', (file: fs.PathLike) => (
            String(file) === configPath ? false : originalExists(file)
        ));
        const lstatMock = t.mock.method(mutableFs, 'lstatSync', (...args: unknown[]) => {
            if (String(args[0]) === configPath) throw unavailable;
            return Reflect.apply(originalLstat, mutableFs, args);
        });
        try {
            assert.deepEqual(readWorkflowConfigForMerge(configPath), { status: 'invalid_json', config: null });
            assert.throws(() => syncWorkflowConfigWithTemplate(bundleRoot), /existing.*workflow.config|workflow.config.*existing/i);
            assert.equal(fs.readFileSync(configPath, 'utf8'), '{"retained":true}');
        } finally {
            existsMock.mock.restore();
            lstatMock.mock.restore();
            fs.rmSync(bundleRoot, { recursive: true, force: true });
        }
    });

    it('classifies a dangling existing link as failure rather than permitted absence', (t) => {
        if (process.platform === 'win32') return t.skip('Symlink fixture requires POSIX permissions.');
        const bundleRoot = mkTmpBundle();
        const configPath = path.join(bundleRoot, 'live', 'config', 'workflow-config.json');
        try {
            fs.symlinkSync(path.join(bundleRoot, 'missing.json'), configPath);
            assert.deepEqual(readWorkflowConfigForMerge(configPath), { status: 'invalid_json', config: null });
            assert.throws(() => syncWorkflowConfigWithTemplate(bundleRoot), /existing.*workflow.config|workflow.config.*existing/i);
            assert.equal(fs.lstatSync(configPath).isSymbolicLink(), true);
        } finally {
            fs.rmSync(bundleRoot, { recursive: true, force: true });
        }
    });

    it('rejects a directory in place of the configuration without creating defaults', () => {
        const bundleRoot = mkTmpBundle();
        const configPath = path.join(bundleRoot, 'live', 'config', 'workflow-config.json');
        try {
            fs.mkdirSync(configPath);
            assert.deepEqual(readWorkflowConfigForMerge(configPath), { status: 'invalid_json', config: null });
            assert.throws(() => syncWorkflowConfigWithTemplate(bundleRoot), /existing.*workflow.config/i);
            assert.deepEqual(fs.readdirSync(configPath), []);
        } finally {
            fs.rmSync(bundleRoot, { recursive: true, force: true });
        }
    });

    it('rejects a dangling ancestor instead of treating the child as missing', (t) => {
        if (process.platform === 'win32') return t.skip('Symlink fixture requires POSIX permissions.');
        const bundleRoot = mkTmpBundle();
        const configRoot = path.join(bundleRoot, 'live', 'config');
        const configPath = path.join(configRoot, 'workflow-config.json');
        try {
            fs.rmdirSync(configRoot);
            fs.symlinkSync(path.join(bundleRoot, 'missing-config-directory'), configRoot);
            assert.deepEqual(readWorkflowConfigForMerge(configPath), { status: 'invalid_json', config: null });
            assert.throws(() => syncWorkflowConfigWithTemplate(bundleRoot), /existing.*workflow.config/i);
            assert.equal(fs.lstatSync(configRoot).isSymbolicLink(), true);
        } finally {
            fs.rmSync(bundleRoot, { recursive: true, force: true });
        }
    });
});

describe('task-scoped test-selection configuration', () => {
    it('defaults fresh and omitted legacy permission to autonomous selection', () => {
        const defaults = buildDefaultWorkflowConfig();
        const template = JSON.parse(fs.readFileSync('template/config/workflow-config.json', 'utf8'));
        assert.deepEqual(defaults.task_test_selection, { require_operator_confirmation: false });
        assert.deepEqual(template.task_test_selection, defaults.task_test_selection);
        for (const existing of [null, { custom_setting: 'retained' }]) {
            const merged = mergeWorkflowConfigWithTemplate(defaults, existing);
            assert.deepEqual(merged.task_test_selection, defaults.task_test_selection);
            if (existing) assert.equal(merged.custom_setting, 'retained');
        }
    });

    for (const requireOperatorConfirmation of [true, false]) {
        it(`preserves explicit confirmation=${requireOperatorConfirmation} and unrelated gate choices on update`, () => {
            const bundleRoot = mkTmpBundle();
            try {
                const defaults = buildDefaultWorkflowConfig();
                const existing = {
                    ...defaults,
                    task_test_selection: { require_operator_confirmation: requireOperatorConfirmation },
                    compile_gate: { command: 'npm run typecheck' },
                    full_suite_validation: {
                        ...defaults.full_suite_validation,
                        enabled: true,
                        command: 'npm test -- tests/owned-scope.test.ts',
                        timeout_ms: 900_000,
                        timeout_retry_count: 1
                    },
                    local_commit: { enabled: true },
                    custom_setting: { retained: true }
                };
                const configPath = path.join(bundleRoot, 'live', 'config', 'workflow-config.json');
                fs.writeFileSync(path.join(bundleRoot, 'template', 'config', 'workflow-config.json'), JSON.stringify(defaults));
                fs.writeFileSync(configPath, JSON.stringify(existing));
                const updated = syncWorkflowConfigWithTemplate(bundleRoot);
                for (const key of [
                    'task_test_selection', 'compile_gate', 'full_suite_validation', 'local_commit',
                    'review_execution_policy', 'scope_budget_guard', 'review_cycle_guard',
                    'project_memory_maintenance', 'task_reset', 'auto_backup',
                    'orchestrator_work_policy', 'custom_setting'
                ] as const) {
                    assert.deepEqual(updated[key], existing[key]);
                }
                assert.deepEqual(JSON.parse(fs.readFileSync(configPath, 'utf8')), updated);
            } finally {
                fs.rmSync(bundleRoot, { recursive: true, force: true });
            }
        });
    }
});

describe('workflow config template diagnostics', () => {
    it('warns when workflow-config template JSON is malformed before falling back to defaults', () => {
        const bundleRoot = mkTmpBundle();
        try {
            fs.writeFileSync(
                path.join(bundleRoot, 'template', 'config', 'workflow-config.json'),
                '{ invalid json',
                'utf8'
            );

            const stderr = captureStderr(() => {
                syncWorkflowConfigWithTemplate(bundleRoot);
            });

            assert.match(stderr, /WORKFLOW_CONFIG_TEMPLATE_FALLBACK/);
            assert.match(stderr, /reason=invalid_json_template:/);
            const materialized = JSON.parse(fs.readFileSync(
                path.join(bundleRoot, 'live', 'config', 'workflow-config.json'),
                'utf8'
            ));
            assert.equal(materialized.full_suite_validation.enabled, false);
        } finally {
            fs.rmSync(bundleRoot, { recursive: true, force: true });
        }
    });

    it('warns when workflow-config template JSON is not an object before falling back to defaults', () => {
        const bundleRoot = mkTmpBundle();
        try {
            fs.writeFileSync(
                path.join(bundleRoot, 'template', 'config', 'workflow-config.json'),
                '[]',
                'utf8'
            );

            const stderr = captureStderr(() => {
                syncWorkflowConfigWithTemplate(bundleRoot);
            });

            assert.match(stderr, /WORKFLOW_CONFIG_TEMPLATE_FALLBACK/);
            assert.match(stderr, /reason=non_object_template/);
        } finally {
            fs.rmSync(bundleRoot, { recursive: true, force: true });
        }
    });
});

describe('workflow config review cycle guard defaults', () => {
    it('migrates the exact previous generated default to ten failed reviews', () => {
        const previousGeneratedDefault = {
            enabled: true,
            action: 'BLOCK_FOR_OPERATOR_DECISION',
            max_failed_non_test_reviews: 15,
            max_total_non_test_reviews: 30,
            excluded_review_types: ['test'],
            auto_split_enabled: true
        };

        assert.equal(isExactLegacyReviewCycleGuardGeneratedDefault(previousGeneratedDefault), true);

        const merged = mergeWorkflowConfigWithTemplate(buildDefaultWorkflowConfig(), {
            review_cycle_guard: previousGeneratedDefault
        });
        const reviewCycleGuard = merged.review_cycle_guard as Record<string, unknown>;
        assert.equal(reviewCycleGuard.max_failed_non_test_reviews, 10);
    });

    it('preserves a custom failed-review limit', () => {
        const merged = mergeWorkflowConfigWithTemplate(buildDefaultWorkflowConfig(), {
            review_cycle_guard: {
                enabled: true,
                action: 'BLOCK_FOR_OPERATOR_DECISION',
                max_failed_non_test_reviews: 12,
                max_total_non_test_reviews: 30,
                excluded_review_types: ['test'],
                auto_split_enabled: true
            }
        });
        const reviewCycleGuard = merged.review_cycle_guard as Record<string, unknown>;
        assert.equal(reviewCycleGuard.max_failed_non_test_reviews, 12);
    });
});
