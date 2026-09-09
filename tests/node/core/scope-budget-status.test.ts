import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { readLatestScopeBudgetStatus } from '../../../src/core/scope-budget-status';

function writeJson(filePath: string, value: unknown): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

describe('readLatestScopeBudgetStatus', () => {
    it('binds a blocking result to the selected preflight artifact', () => {
        const targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-scope-budget-status-'));
        const bundleRoot = path.join(targetRoot, 'garda-agent-orchestrator');
        const preflightPath = path.join(bundleRoot, 'runtime', 'reviews', 'T-900-preflight.json');
        const workflowConfigPath = path.join(bundleRoot, 'live', 'config', 'workflow-config.json');
        const preflight = {
            profile_selection: { effective_profile: 'balanced' },
            changed_files: ['a.ts', 'b.ts', 'c.ts'],
            metrics: { changed_lines_total: 10 },
            budget_forecast: {
                required_reviews: ['code'],
                total_estimated_review_tokens: 100
            }
        };

        try {
            writeJson(workflowConfigPath, {
                scope_budget_guard: {
                    enabled: true,
                    profiles: ['balanced'],
                    action: 'BLOCK_FOR_SPLIT',
                    warn_files: 1,
                    block_files: 2,
                    warn_changed_lines: 10,
                    block_changed_lines: 20,
                    warn_required_reviews: 1,
                    block_required_reviews: 3,
                    warn_review_tokens: 100,
                    block_review_tokens: 200
                }
            });
            writeJson(preflightPath, preflight);

            const result = readLatestScopeBudgetStatus({ targetRoot, bundleRoot, preflightPath });
            const expectedSha256 = createHash('sha256').update(fs.readFileSync(preflightPath)).digest('hex');

            assert.equal(result.status, 'BLOCK');
            assert.equal(result.profile_name, 'balanced');
            assert.equal(result.preflight_path, preflightPath);
            assert.equal(result.preflight_sha256, expectedSha256);
            assert.equal(result.changed_files_count, 3);
            assert.equal(result.changed_lines_total, 10);
            assert.equal(result.required_review_count, 1);
            assert.equal(result.total_estimated_review_tokens, 100);
            assert.equal(result.continuation_allowed, false);
            assert.deepEqual(result.violations.map((violation) => violation.metric), ['changed_files_count']);
            assert.equal(result.unavailable_reason, null);
        } finally {
            fs.rmSync(targetRoot, { recursive: true, force: true });
        }
    });

    it('fails closed for preflight paths outside runtime reviews', () => {
        const targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-scope-budget-path-'));
        const bundleRoot = path.join(targetRoot, 'garda-agent-orchestrator');

        try {
            const result = readLatestScopeBudgetStatus({
                targetRoot,
                bundleRoot,
                preflightPath: path.join(targetRoot, 'outside-preflight.json')
            });

            assert.equal(result.status, 'unavailable');
            assert.equal(result.continuation_allowed, null);
            assert.match(result.unavailable_reason || '', /outside runtime reviews/);
        } finally {
            fs.rmSync(targetRoot, { recursive: true, force: true });
        }
    });

    it('reports invalid workflow configuration instead of using ambiguous limits', () => {
        const targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-scope-budget-config-'));
        const bundleRoot = path.join(targetRoot, 'garda-agent-orchestrator');
        const preflightPath = path.join(bundleRoot, 'runtime', 'reviews', 'T-901-preflight.json');
        const workflowConfigPath = path.join(bundleRoot, 'live', 'config', 'workflow-config.json');

        try {
            writeJson(preflightPath, { profile_selection: { effective_profile: 'balanced' } });
            fs.mkdirSync(path.dirname(workflowConfigPath), { recursive: true });
            fs.writeFileSync(workflowConfigPath, '{ invalid json', 'utf8');

            const result = readLatestScopeBudgetStatus({ targetRoot, bundleRoot, preflightPath });

            assert.equal(result.status, 'unavailable');
            assert.equal(result.unavailable_reason, 'workflow config is invalid JSON');
        } finally {
            fs.rmSync(targetRoot, { recursive: true, force: true });
        }
    });
});
