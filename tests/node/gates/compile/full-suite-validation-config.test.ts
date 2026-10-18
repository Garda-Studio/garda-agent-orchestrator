import { describe, it, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { UNCONFIGURED_FULL_SUITE_VALIDATION_COMMAND } from '../../../../src/core/constants';
import {
    DEFAULT_FULL_SUITE_VALIDATION_CONFIG,
    loadFullSuiteValidationConfig as loadCoreConfig,
    resolveWorkflowConfigPath
} from '../../../../src/core/full-suite-validation-config';
import {
    buildFullSuiteConfigSignature,
    loadFullSuiteValidationConfig
} from '../../../../src/gates/full-suite/full-suite-validation';

function createConfigFixture(context: TestContext, value: unknown): { root: string; configPath: string } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-fsv-config-'));
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const configPath = path.join(root, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(value));
    return { root, configPath };
}
describe('gates/full-suite-validation', () => {
    it('binds declared report paths and byte limits to the suite config signature', context => {
        const fixture = createConfigFixture(context, { full_suite_validation: {
            enabled: true, command: 'custom-suite', report_files: [{ path: 'reports/suite.xml', max_bytes: 4096 }]
        } });
        const config = loadCoreConfig(fixture.root);
        assert.deepEqual(config.report_files, [{ path: 'reports/suite.xml', max_bytes: 4096 }]);
        const signature = buildFullSuiteConfigSignature(config);
        assert.notEqual(buildFullSuiteConfigSignature({ ...config,
            report_files: [{ path: 'reports/suite.xml', max_bytes: 8192 }] }), signature);
        assert.notEqual(buildFullSuiteConfigSignature({ ...config, report_files: [] }), signature);
        fs.writeFileSync(fixture.configPath, JSON.stringify({ full_suite_validation: {
            enabled: true, command: 'custom-suite', report_files: [{ path: '../foreign.xml', max_bytes: 4096 }]
        } }));
        assert.throws(() => loadCoreConfig(fixture.root), /relative|report|path/i);
    });
    describe('loadFullSuiteValidationConfig', () => {
        it('returns defaults when config file does not exist', () => {
            const config = loadFullSuiteValidationConfig('/nonexistent/path');
            assert.equal(config.enabled, false);
            assert.equal(config.command, UNCONFIGURED_FULL_SUITE_VALIDATION_COMMAND);
            assert.equal(config.timeout_ms, 900_000);
            assert.equal(config.timeout_blocker, true);
            assert.equal(config.timeout_retry_count, 1);
            assert.equal(config.green_summary_max_lines, 5);
            assert.equal(config.red_failure_chunk_lines, 50);
            assert.equal(config.out_of_scope_failure_policy, 'AUDIT_AND_BLOCK');
            assert.equal(config.placement, 'after_compile_before_reviews');
        });

        it('loads enabled config from valid JSON', () => {
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-fsv-'));
            const configDir = path.join(tempDir, 'garda-agent-orchestrator', 'live', 'config');
            fs.mkdirSync(configDir, { recursive: true });
            fs.writeFileSync(path.join(configDir, 'workflow-config.json'), JSON.stringify({
                full_suite_validation: {
                    enabled: true,
                    command: 'npm run test:all',
                    timeout_ms: 300000,
                    timeout_blocker: false,
                    timeout_retry_count: 0,
                    green_summary_max_lines: 3,
                    red_failure_chunk_lines: 25,
                    out_of_scope_failure_policy: 'AUDIT_AND_WARN',
                    placement: 'before completion'
                }
            }));

            const config = loadFullSuiteValidationConfig(tempDir);
            assert.equal(config.enabled, true);
            assert.equal(config.command, 'npm run test:all');
            assert.equal(config.timeout_ms, 300000);
            assert.equal(config.timeout_blocker, false);
            assert.equal(config.timeout_retry_count, 0);
            assert.equal(config.green_summary_max_lines, 3);
            assert.equal(config.red_failure_chunk_lines, 25);
            assert.equal(config.out_of_scope_failure_policy, 'AUDIT_AND_WARN');
            assert.equal(config.placement, 'before_completion');
            fs.rmSync(tempDir, { recursive: true, force: true });
        });

        it('loads full-suite timeout policy from normalized string config values', () => {
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-fsv-'));
            const configDir = path.join(tempDir, 'garda-agent-orchestrator', 'live', 'config');
            fs.mkdirSync(configDir, { recursive: true });
            fs.writeFileSync(path.join(configDir, 'workflow-config.json'), JSON.stringify({
                full_suite_validation: {
                    enabled: true,
                    command: 'npm run test:all',
                    timeout_ms: 300000,
                    timeout_blocker: 'no',
                    timeout_retry_count: '0',
                    green_summary_max_lines: 3,
                    red_failure_chunk_lines: 25,
                    out_of_scope_failure_policy: 'AUDIT_AND_WARN',
                    placement: 'before completion'
                }
            }));

            const config = loadFullSuiteValidationConfig(tempDir);
            assert.equal(config.timeout_blocker, false);
            assert.equal(config.timeout_retry_count, 0);
            fs.rmSync(tempDir, { recursive: true, force: true });
        });

        it('rejects excessive full-suite timeout retry count from config', () => {
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-fsv-'));
            const configDir = path.join(tempDir, 'garda-agent-orchestrator', 'live', 'config');
            fs.mkdirSync(configDir, { recursive: true });
            fs.writeFileSync(path.join(configDir, 'workflow-config.json'), JSON.stringify({
                full_suite_validation: {
                    enabled: true,
                    command: 'npm run test:all',
                    timeout_ms: 300000,
                    timeout_retry_count: 4,
                    green_summary_max_lines: 3,
                    red_failure_chunk_lines: 25,
                    out_of_scope_failure_policy: 'AUDIT_AND_WARN',
                    placement: 'before completion'
                }
            }));

            assert.throws(() => loadFullSuiteValidationConfig(tempDir), /timeout_retry_count/);
            fs.rmSync(tempDir, { recursive: true, force: true });
        });

        it('rejects malformed JSON without exposing configuration contents', () => {
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-fsv-'));
            const configDir = path.join(tempDir, 'garda-agent-orchestrator', 'live', 'config');
            fs.mkdirSync(configDir, { recursive: true });
            fs.writeFileSync(path.join(configDir, 'workflow-config.json'), '{"secret":"must-not-appear",');
            assert.throws(() => loadFullSuiteValidationConfig(tempDir), (error: unknown) => {
                assert.ok(error instanceof Error);
                assert.match(error.message, /workflow-config.*invalid JSON/);
                assert.doesNotMatch(error.message, /must-not-appear/);
                return true;
            });
            fs.rmSync(tempDir, { recursive: true, force: true });
        });

        it('rejects parseable non-object JSON', () => {
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-fsv-'));
            const configDir = path.join(tempDir, 'garda-agent-orchestrator', 'live', 'config');
            fs.mkdirSync(configDir, { recursive: true });
            fs.writeFileSync(path.join(configDir, 'workflow-config.json'), 'null');
            assert.throws(() => loadFullSuiteValidationConfig(tempDir), /workflow-config must be a JSON object/);
            fs.rmSync(tempDir, { recursive: true, force: true });
        });

        it('rejects invalid explicit placement values', () => {
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-fsv-'));
            const configDir = path.join(tempDir, 'garda-agent-orchestrator', 'live', 'config');
            fs.mkdirSync(configDir, { recursive: true });
            fs.writeFileSync(path.join(configDir, 'workflow-config.json'), JSON.stringify({
                full_suite_validation: {
                    enabled: true,
                    command: 'npm test',
                    timeout_ms: 300000,
                    green_summary_max_lines: 3,
                    red_failure_chunk_lines: 25,
                    out_of_scope_failure_policy: 'AUDIT_AND_BLOCK',
                    placement: 'after lunch'
                }
            }));

            assert.throws(
                () => loadFullSuiteValidationConfig(tempDir),
                /workflow-config\.full_suite_validation\.placement must be one of/
            );
            fs.rmSync(tempDir, { recursive: true, force: true });
        });

        it('shares one fail-closed reader between core and the gate facade', () => {
            assert.equal(loadFullSuiteValidationConfig, loadCoreConfig);
        });

        it('preserves defaults for absent sections and omitted fields', (context) => {
            for (const value of [{}, { compile_gate: { command: 'npm run typecheck' } }, { full_suite_validation: {} }]) {
                const { root } = createConfigFixture(context, value);
                assert.deepEqual(loadCoreConfig(root), DEFAULT_FULL_SUITE_VALIDATION_CONFIG);
            }
            const { root } = createConfigFixture(context, { full_suite_validation: { enabled: true } });
            assert.deepEqual(loadCoreConfig(root), { ...DEFAULT_FULL_SUITE_VALIDATION_CONFIG, enabled: true });
        });

        for (const value of [[], false, 0, 'config']) {
            it(`rejects a ${JSON.stringify(value)} config root`, (context) => {
                const { root } = createConfigFixture(context, value);
                assert.throws(() => loadCoreConfig(root), /workflow-config must be a JSON object/);
            });
        }

        for (const value of [null, [], false, 0, 'enabled']) {
            it(`rejects a ${JSON.stringify(value)} full-suite section`, (context) => {
                const { root } = createConfigFixture(context, { full_suite_validation: value });
                assert.throws(() => loadCoreConfig(root), /full_suite_validation must be a JSON object/);
            });
        }

        const invalidFields: Record<string, unknown[]> = {
            enabled: [null, [], {}, 'invalid'],
            command: [null, [], {}, 1, ' '],
            timeout_ms: [null, [], {}, 0, -1, 1.5, 'invalid', Number.MAX_SAFE_INTEGER + 1],
            timeout_blocker: [null, [], {}, 'invalid'],
            timeout_retry_count: [null, [], {}, -1, 1.5, 4, 'invalid'],
            green_summary_max_lines: [null, [], {}, 0, 1.5, 'invalid'],
            red_failure_chunk_lines: [null, [], {}, 0, 1.5, 'invalid'],
            out_of_scope_failure_policy: [null, [], {}, 'ignore'],
            placement: [null, [], {}, ['before_completion'], [['before_completion']], 'after lunch']
        };
        for (const [field, values] of Object.entries(invalidFields)) {
            it(`rejects invalid explicit ${field} even when the gate is disabled`, (context) => {
                for (const value of values) {
                    const { root } = createConfigFixture(context, { full_suite_validation: { enabled: false, [field]: value } });
                    assert.throws(() => loadCoreConfig(root), new RegExp(`full_suite_validation\\.${field}`), JSON.stringify(value));
                }
            });
        }

        it('normalizes supported scalar values without disabling enabled validation', (context) => {
            const { root } = createConfigFixture(context, { full_suite_validation: {
                enabled: 'yes', command: ' npm test ', timeout_ms: '30000', timeout_blocker: 0,
                timeout_retry_count: '0', green_summary_max_lines: '3', red_failure_chunk_lines: '10',
                out_of_scope_failure_policy: 'audit-and-warn', placement: 'before completion'
            } });
            assert.deepEqual(loadCoreConfig(root), {
                enabled: true, command: 'npm test', timeout_ms: 30000, timeout_blocker: false,
                timeout_retry_count: 0, green_summary_max_lines: 3, red_failure_chunk_lines: 10,
                out_of_scope_failure_policy: 'AUDIT_AND_WARN', placement: 'before_completion'
            });
        });

        it('preserves positive sub-second timeout values used by runtime callers', (context) => {
            const { root } = createConfigFixture(context, { full_suite_validation: { enabled: true, timeout_ms: 1 } });
            assert.equal(loadCoreConfig(root).timeout_ms, 1);
        });

        it('rejects config paths that are directories or have non-directory ancestors', (context) => {
            const { root, configPath } = createConfigFixture(context, {});
            fs.unlinkSync(configPath);
            fs.mkdirSync(configPath);
            assert.throws(() => loadCoreConfig(root), /workflow-config.*read|workflow-config.*file/i);
            fs.rmSync(path.dirname(configPath), { recursive: true });
            fs.writeFileSync(path.dirname(configPath), 'not a directory');
            assert.throws(() => loadCoreConfig(root), /workflow-config.*read|workflow-config.*file/i);
        });

        it('rejects an unreadable existing config on POSIX', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, (context) => {
            const { root, configPath } = createConfigFixture(context, { full_suite_validation: { enabled: true } });
            fs.chmodSync(configPath, 0);
            try {
                assert.throws(() => loadCoreConfig(root), /workflow-config.*read/i);
            } finally {
                fs.chmodSync(configPath, 0o600);
            }
        });

        it('rejects a dangling config symlink rather than treating it as absence', { skip: process.platform === 'win32' }, (context) => {
            const { root, configPath } = createConfigFixture(context, {});
            fs.unlinkSync(configPath);
            fs.symlinkSync(path.join(path.dirname(configPath), 'missing.json'), configPath);
            assert.throws(() => loadCoreConfig(root), /workflow-config.*read|workflow-config.*file/i);
        });

        it('rejects a dangling directory ancestor rather than disabling validation', { skip: process.platform === 'win32' }, (context) => {
            const { root, configPath } = createConfigFixture(context, { full_suite_validation: { enabled: true } });
            const configDir = path.dirname(configPath);
            fs.renameSync(configDir, `${configDir}-original`);
            fs.symlinkSync(path.join(path.dirname(configDir), 'missing-config-directory'), configDir);
            assert.throws(() => loadCoreConfig(root), /workflow-config.*read|workflow-config.*file/i);
        });

        it('preserves absence defaults beneath a valid directory symlink', { skip: process.platform === 'win32' }, (context) => {
            const { root, configPath } = createConfigFixture(context, {});
            const configDir = path.dirname(configPath);
            fs.unlinkSync(configPath);
            fs.renameSync(configDir, `${configDir}-target`);
            fs.symlinkSync(`${configDir}-target`, configDir);
            assert.deepEqual(loadCoreConfig(root), DEFAULT_FULL_SUITE_VALIDATION_CONFIG);
        });

        it('rejects a dangling deployed bundle instead of taking disabled fallback defaults', { skip: process.platform === 'win32' }, (context) => {
            for (const name of ['garda-agent-orchestrator', 'Garda-Agent-Orchestrator']) {
                const { root } = createConfigFixture(context, { full_suite_validation: { enabled: true } });
                const bundlePath = path.join(root, 'garda-agent-orchestrator');
                fs.renameSync(bundlePath, `${bundlePath}-original`);
                fs.symlinkSync(path.join(root, 'missing-bundle'), path.join(root, name));
                assert.throws(() => loadCoreConfig(root), /workflow-config.*read|workflow-config.*file/i);
            }
        });

        it('preserves enabled configuration beneath a valid deployed bundle symlink', { skip: process.platform === 'win32' }, (context) => {
            for (const name of ['garda-agent-orchestrator', 'Garda-Agent-Orchestrator']) {
                const { root } = createConfigFixture(context, { full_suite_validation: { enabled: true } });
                const bundlePath = path.join(root, 'garda-agent-orchestrator');
                fs.renameSync(bundlePath, `${bundlePath}-target`);
                fs.symlinkSync(`${bundlePath}-target`, path.join(root, name));
                assert.equal(resolveWorkflowConfigPath(root), path.join(root, name, 'live', 'config', 'workflow-config.json'));
                assert.deepEqual(loadCoreConfig(root), { ...DEFAULT_FULL_SUITE_VALIDATION_CONFIG, enabled: true });
            }
        });

        it('rejects invalid configuration beneath a valid case-variant bundle symlink', { skip: process.platform === 'win32' }, (context) => {
            for (const contents of ['{ invalid json', '{"full_suite_validation":{"enabled":true,"placement":["before_completion"]}}']) {
                const { root, configPath } = createConfigFixture(context, {});
                fs.writeFileSync(configPath, contents);
                const bundlePath = path.join(root, 'garda-agent-orchestrator');
                fs.renameSync(bundlePath, `${bundlePath}-target`);
                fs.symlinkSync(`${bundlePath}-target`, path.join(root, 'Garda-Agent-Orchestrator'));
                assert.throws(() => loadCoreConfig(root), /workflow-config/);
            }
        });

        it('rejects ambiguous recognized deployed links instead of disabling validation', { skip: process.platform === 'win32' }, (context) => {
            const { root } = createConfigFixture(context, { full_suite_validation: { enabled: true } });
            const bundlePath = path.join(root, 'garda-agent-orchestrator');
            fs.renameSync(bundlePath, `${bundlePath}-target`);
            for (const name of ['Garda-Agent-Orchestrator', 'GARDA-AGENT-ORCHESTRATOR']) {
                if (fs.existsSync(path.join(root, name))) {
                    context.skip('Ambiguous-case fixture requires a case-sensitive filesystem.');
                    return;
                }
                fs.symlinkSync(`${bundlePath}-target`, path.join(root, name));
            }
            assert.throws(() => loadCoreConfig(root), /workflow-config.*ambiguous/);
        });

        it('preserves valid configuration in a standalone bundle root', (context) => {
            const { root } = createConfigFixture(context, { full_suite_validation: { enabled: true, command: 'npm test' } });
            const bundlePath = path.join(root, 'garda-agent-orchestrator');
            fs.renameSync(path.join(bundlePath, 'live'), path.join(root, 'live'));
            fs.rmdirSync(bundlePath);
            assert.deepEqual(loadCoreConfig(root), { ...DEFAULT_FULL_SUITE_VALIDATION_CONFIG, enabled: true, command: 'npm test' });
        });

        it('preserves an identified standalone bundle over unselected deployment entries', { skip: process.platform === 'win32' }, (context) => {
            for (const childKind of ['regular-file', 'dangling-link', 'case-variant-valid-link']) {
                const { root } = createConfigFixture(context, { full_suite_validation: { enabled: true } });
                const bundlePath = path.join(root, 'garda-agent-orchestrator');
                fs.renameSync(path.join(bundlePath, 'live'), path.join(root, 'live'));
                fs.rmdirSync(bundlePath);
                fs.writeFileSync(path.join(root, 'MANIFEST.md'), 'standalone bundle fixture');
                fs.writeFileSync(path.join(root, 'VERSION'), '1.4.4');
                if (childKind === 'regular-file') {
                    fs.writeFileSync(bundlePath, 'unselected child');
                } else if (childKind === 'dangling-link') {
                    fs.symlinkSync(path.join(root, 'missing-target'), bundlePath);
                } else {
                    fs.mkdirSync(path.join(root, 'unselected-bundle'));
                    fs.symlinkSync(path.join(root, 'unselected-bundle'), path.join(root, 'Garda-Agent-Orchestrator'));
                }
                assert.equal(resolveWorkflowConfigPath(root), path.join(root, 'live', 'config', 'workflow-config.json'));
                assert.deepEqual(loadCoreConfig(root), { ...DEFAULT_FULL_SUITE_VALIDATION_CONFIG, enabled: true });
            }
        });

        it('includes timeout policy fields in the config signature', () => {
            const config = loadFullSuiteValidationConfig('/nonexistent/path');
            assert.notEqual(
                buildFullSuiteConfigSignature(config),
                buildFullSuiteConfigSignature({ ...config, timeout_blocker: false })
            );
            assert.notEqual(
                buildFullSuiteConfigSignature(config),
                buildFullSuiteConfigSignature({ ...config, timeout_retry_count: 0 })
            );
        });
    });
});
