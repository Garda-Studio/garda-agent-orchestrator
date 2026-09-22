import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import * as facade from '../../../../src/gates/workflow-config/workflow-config-work';
import { getAuditedWorkflowConfigChangeProvenance } from '../../../../src/gates/workflow-config/workflow-config-work-audit';
import { getWorkflowConfigPreTaskBaselineState } from '../../../../src/gates/workflow-config/workflow-config-work-baseline';
import {
    hasUnsafeIgnoredWorkflowConfigCompatibilityBaseline
} from '../../../../src/gates/workflow-config/workflow-config-work-compatibility';
import {
    hasCompatibleOptionalQualityRuleScopeFilters,
    SAFE_WORKFLOW_CONFIG_COMPATIBILITY_BASELINE
} from '../../../../src/gates/workflow-config/workflow-config-work-compatibility-primitives';
import {
    getCurrentWorkflowConfigChanges,
    getWorkflowConfigWorkViolations
} from '../../../../src/gates/workflow-config/workflow-config-work-changes';
import {
    getCurrentWorkflowConfigFileHashes,
    getWorkflowConfigChangedFiles,
    getWorkflowConfigControlPlanePaths,
    normalizeWorkflowConfigFileHashes
} from '../../../../src/gates/workflow-config/workflow-config-work-paths';

const LIVE_CONFIG_PATH = 'garda-agent-orchestrator/live/config/workflow-config.json';

function createTempRoot(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'garda-workflow-config-work-'));
}

function removeTempRoot(repoRoot: string): void {
    fs.rmSync(repoRoot, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100
    });
}

describe('workflow config work module boundaries', () => {
    it('keeps the compatibility facade bound to the extracted operations', () => {
        assert.equal(facade.getWorkflowConfigControlPlanePaths, getWorkflowConfigControlPlanePaths);
        assert.equal(facade.getCurrentWorkflowConfigFileHashes, getCurrentWorkflowConfigFileHashes);
        assert.equal(facade.normalizeWorkflowConfigFileHashes, normalizeWorkflowConfigFileHashes);
        assert.equal(facade.getWorkflowConfigChangedFiles, getWorkflowConfigChangedFiles);
        assert.equal(facade.getWorkflowConfigPreTaskBaselineState, getWorkflowConfigPreTaskBaselineState);
        assert.equal(facade.getAuditedWorkflowConfigChangeProvenance, getAuditedWorkflowConfigChangeProvenance);
        assert.equal(facade.getCurrentWorkflowConfigChanges, getCurrentWorkflowConfigChanges);
        assert.equal(facade.getWorkflowConfigWorkViolations, getWorkflowConfigWorkViolations);
    });

    it('normalizes only workflow-config control-plane hash evidence', () => {
        const templatePath = 'template/config/workflow-config.json';
        assert.deepEqual(normalizeWorkflowConfigFileHashes({
            [LIVE_CONFIG_PATH]: 'A'.repeat(64),
            [templatePath]: 'not-a-hash',
            'README.md': 'B'.repeat(64)
        }), {
            [LIVE_CONFIG_PATH]: 'a'.repeat(64),
            [templatePath]: null
        });
    });

    it('filters, normalizes, de-duplicates, and sorts changed workflow-config paths', () => {
        const templatePath = 'template/config/workflow-config.json';
        assert.deepEqual(getWorkflowConfigChangedFiles([
            templatePath,
            LIVE_CONFIG_PATH.replaceAll('/', '\\'),
            LIVE_CONFIG_PATH,
            'README.md'
        ], [LIVE_CONFIG_PATH, templatePath]), [LIVE_CONFIG_PATH, templatePath]);
    });

    it('reconstructs missing baseline state and current changes without inventing config edits', (t) => {
        const repoRoot = createTempRoot();
        t.after(() => removeTempRoot(repoRoot));
        const currentHashes = { [LIVE_CONFIG_PATH]: null };

        assert.deepEqual(getWorkflowConfigPreTaskBaselineState(repoRoot, currentHashes), {
            changed_files: [],
            compatibility_baseline_files: [],
            git_changed_files: [],
            protected_manifest_changed_files: [],
            protected_manifest_status: 'missing'
        });

        const changes = getCurrentWorkflowConfigChanges(repoRoot, currentHashes, {
            allowProtectedManifestFallback: false
        });
        assert.deepEqual(changes.changed_files, []);
        assert.deepEqual(changes.baseline_file_hashes, currentHashes);
        assert.equal(changes.baseline_source, 'task_mode');
    });

    it('requires guarded task-mode flags unless changed config has accepted provenance', (t) => {
        const repoRoot = createTempRoot();
        t.after(() => removeTempRoot(repoRoot));
        const currentHashes = { [LIVE_CONFIG_PATH]: 'b'.repeat(64) };
        const baselineHashes = { [LIVE_CONFIG_PATH]: 'a'.repeat(64) };

        const provenance = getAuditedWorkflowConfigChangeProvenance({
            repoRoot,
            changedFiles: [LIVE_CONFIG_PATH],
            currentFileHashes: currentHashes,
            taskId: 'T-930-3'
        });
        assert.equal(provenance.accepted, false);
        assert.deepEqual(provenance.unaudited_files, [LIVE_CONFIG_PATH]);

        const blocked = getWorkflowConfigWorkViolations({
            repoRoot,
            changedFiles: [LIVE_CONFIG_PATH],
            taskModeEvidence: { task_id: 'T-930-3' },
            phaseLabel: 'focused validation',
            baselineFileHashes: baselineHashes,
            currentFileHashes: currentHashes
        });
        assert.match(blocked.join('\n'), /without task-mode --orchestrator-work --workflow-config-work/);

        const authorized = getWorkflowConfigWorkViolations({
            changedFiles: [LIVE_CONFIG_PATH],
            taskModeEvidence: {
                task_id: 'T-930-3',
                orchestrator_work: true,
                workflow_config_work: true
            },
            phaseLabel: 'focused validation',
            baselineFileHashes: baselineHashes,
            currentFileHashes: currentHashes
        });
        assert.deepEqual(authorized, []);
    });

    it('accepts the safe compatibility baseline and rejects weakened config', (t) => {
        const repoRoot = createTempRoot();
        t.after(() => removeTempRoot(repoRoot));
        const configPath = path.join(repoRoot, ...LIVE_CONFIG_PATH.split('/'));
        fs.mkdirSync(path.dirname(configPath), { recursive: true });
        fs.writeFileSync(
            configPath,
            `${JSON.stringify(SAFE_WORKFLOW_CONFIG_COMPATIBILITY_BASELINE, null, 2)}\n`,
            'utf8'
        );
        assert.equal(
            hasUnsafeIgnoredWorkflowConfigCompatibilityBaseline(repoRoot, LIVE_CONFIG_PATH),
            false
        );

        fs.writeFileSync(
            configPath,
            `${JSON.stringify({
                ...SAFE_WORKFLOW_CONFIG_COMPATIBILITY_BASELINE,
                compact: {
                    ...(SAFE_WORKFLOW_CONFIG_COMPATIBILITY_BASELINE.compact as Record<string, unknown>),
                    run_bytes: Number.MAX_SAFE_INTEGER
                }
            }, null, 2)}\n`,
            'utf8'
        );
        assert.equal(
            hasUnsafeIgnoredWorkflowConfigCompatibilityBaseline(repoRoot, LIVE_CONFIG_PATH),
            true
        );

        fs.writeFileSync(configPath, '{}\n', 'utf8');
        assert.equal(
            hasUnsafeIgnoredWorkflowConfigCompatibilityBaseline(repoRoot, LIVE_CONFIG_PATH),
            true
        );
    });

    it('keeps optional quality-rule scope filters fail-closed', () => {
        const defaultRule = {
            excluded_scope_categories: ['docs'],
            included_scope_categories: ['mixed'],
            included_changed_file_regexes: ['^src/']
        };
        assert.equal(hasCompatibleOptionalQualityRuleScopeFilters({
            included_scope_categories: ['mixed'],
            included_changed_file_regexes: ['^src/']
        }, defaultRule), true);
        assert.equal(hasCompatibleOptionalQualityRuleScopeFilters({
            included_scope_categories: ['tests'],
            included_changed_file_regexes: ['^src/']
        }, defaultRule), false);
    });
});
