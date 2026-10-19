import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildDefaultWorkflowConfig, mergeWorkflowConfigWithTemplate, syncWorkflowConfigWithTemplate } from '../../../src/core/workflow-config';
import { captureWorkflowConfigMigration, recordWorkflowConfigMigration } from '../../../src/core/workflow-config-migration';
import { isAuthenticatedWorkflowMigration, resolveLocalCommitAvailability } from '../../../src/core/auth/local-commit-availability';
import { handleSet } from '../../../src/cli/commands/workflow/workflow-command-set';
import { readProjectValidationAuthority, readProjectValidationFileRoles } from '../../../src/core/project-validation-authority';
import { currentProjectValidationAuthority, freezeProjectValidationAdmission } from '../../../src/gates/project-validation/authority';

function fixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-migration-'));
    assert.equal(spawnSync('git', ['init', '--quiet'], { cwd: root, windowsHide: true }).status, 0);
    const bundle = path.join(root, 'garda-agent-orchestrator');
    const configPath = path.join(bundle, 'live/config/workflow-config.json');
    const templatePath = path.join(bundle, 'template/config/workflow-config.json');
    for (const file of [configPath, templatePath]) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(buildDefaultWorkflowConfig(), null, 2));
    }
    return { root, bundle, configPath, templatePath, auditPath: path.join(bundle, 'runtime/workflow-config-audit.jsonl') };
}

function permission(root: string, enabled: boolean): void {
    handleSet({ targetRoot: root, localCommitEnabled: String(enabled), json: true,
        operatorConfirmed: 'yes', operatorConfirmedAtUtc: new Date().toISOString() });
}

function addManagedRule(f: ReturnType<typeof fixture>): void {
    const template = JSON.parse(fs.readFileSync(f.templatePath, 'utf8'));
    template.optional_quality_checks.rules.push({ id: 'migration_test_rule', title: 'Migration test',
        prompt: 'Verify migration behavior.', enabled: true, applies_to: ['code'] });
    fs.writeFileSync(f.templatePath, JSON.stringify(template, null, 2));
    const previous = JSON.parse(fs.readFileSync(f.configPath, 'utf8'));
    fs.writeFileSync(f.configPath, JSON.stringify(mergeWorkflowConfigWithTemplate(template, previous, {
        preserveLegacyReviewExecutionPolicyOmission: true
    }), null, 2));
}

test('workflow synchronization preserves byte identity for unchanged compact configuration', () => {
    const f = fixture();
    try {
        syncWorkflowConfigWithTemplate(f.bundle);
        const compact = JSON.stringify(JSON.parse(fs.readFileSync(f.configPath, 'utf8')));
        fs.writeFileSync(f.configPath, compact);
        syncWorkflowConfigWithTemplate(f.bundle);
        assert.ok(fs.readFileSync(f.configPath).equals(Buffer.from(compact)), 'unchanged settings must keep their exact bytes');
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('lifecycle migration preserves an existing grant and keeps provenance after permission rotation', () => {
    const f = fixture();
    try {
        permission(f.root, true);
        const receiptPath = path.join(f.bundle, 'live/config/local-commit-enablement-receipt.json');
        const receipt = fs.readFileSync(receiptPath);
        const baseline = captureWorkflowConfigMigration(f.root);
        addManagedRule(f);
        recordWorkflowConfigMigration(f.root, baseline);
        assert.equal(resolveLocalCommitAvailability(f.root).enabled, true);
        assert.deepEqual(fs.readFileSync(receiptPath), receipt);
        const audit = fs.readFileSync(f.auditPath, 'utf8');
        const migrations = audit.trim().split('\n').map(line => JSON.parse(line))
            .filter(record => record.mutation_source === 'lifecycle');
        assert.equal(migrations.length, 2);
        assert.ok(migrations.every(record => isAuthenticatedWorkflowMigration(f.root, record)));
        recordWorkflowConfigMigration(f.root, captureWorkflowConfigMigration(f.root));
        assert.equal(fs.readFileSync(f.auditPath, 'utf8'), audit);
        permission(f.root, false);
        assert.equal(resolveLocalCommitAvailability(f.root).enabled, false);
        permission(f.root, true);
        assert.ok(migrations.every(record => isAuthenticatedWorkflowMigration(f.root, record)));
        assert.equal(resolveLocalCommitAvailability(f.root).enabled, true);
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('lifecycle migration verifies its audit when Windows path stats omit the volume', {
    skip: process.platform !== 'win32'
}, (t) => {
    const f = fixture();
    const mutableFs = require('node:fs') as typeof fs;
    const originalStat = mutableFs.statSync;
    try {
        permission(f.root, true);
        const receiptPath = path.join(f.bundle, 'live/config/local-commit-enablement-receipt.json');
        const receipt = fs.readFileSync(receiptPath);
        const baseline = captureWorkflowConfigMigration(f.root);
        addManagedRule(f);
        recordWorkflowConfigMigration(f.root, baseline);
        let omittedVolumeObservations = 0;
        t.mock.method(mutableFs, 'statSync', (...args: unknown[]) => {
            const stats = Reflect.apply(originalStat, mutableFs, args) as fs.Stats | fs.BigIntStats;
            if (args[0] !== f.auditPath) return stats;
            omittedVolumeObservations += 1;
            return Object.assign(Object.create(Object.getPrototypeOf(stats)), stats,
                { dev: typeof stats.dev === 'bigint' ? 0n : 0 });
        });
        assert.equal(resolveLocalCommitAvailability(f.root).enabled, true);
        assert.ok(omittedVolumeObservations > 0, 'audit path must actually exercise the missing-volume condition');
        assert.deepEqual(fs.readFileSync(receiptPath), receipt, 'verification must not replace or renew operator authority');
        const edited = JSON.parse(fs.readFileSync(f.auditPath, 'utf8').trim().split('\n').at(-1)!);
        assert.equal(isAuthenticatedWorkflowMigration(f.root, { ...edited, before_sha256: 'f'.repeat(64) }), false);
    } finally { t.mock.restoreAll(); fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('lifecycle migration rejects permission elevation and foreign or edited provenance', () => {
    const f = fixture();
    const foreign = fixture();
    try {
        const baseline = captureWorkflowConfigMigration(f.root);
        assert.throws(() => recordWorkflowConfigMigration(f.root, JSON.parse(JSON.stringify(baseline))), /native capture/);
        const config = JSON.parse(fs.readFileSync(f.configPath, 'utf8'));
        config.local_commit.enabled = true;
        fs.writeFileSync(f.configPath, JSON.stringify(config));
        assert.throws(() => recordWorkflowConfigMigration(f.root, baseline), /existing project settings|cannot grant/);
        fs.writeFileSync(f.configPath, baseline.files.find(file => file.path.includes('/live/'))!.text);
        addManagedRule(f);
        recordWorkflowConfigMigration(f.root, baseline);
        const record = JSON.parse(fs.readFileSync(f.auditPath, 'utf8').trim().split('\n')[0]);
        assert.equal(isAuthenticatedWorkflowMigration(foreign.root, record), false);
        assert.equal(isAuthenticatedWorkflowMigration(f.root, { ...record, before_sha256: 'f'.repeat(64) }), false);
        assert.equal(resolveLocalCommitAvailability(f.root).enabled, false);
    } finally {
        fs.rmSync(f.root, { recursive: true, force: true });
        fs.rmSync(foreign.root, { recursive: true, force: true });
    }
});

test('lifecycle migration preserves recipe admission and file roles while invalidating old preflight bindings', () => {
    const f = fixture();
    try {
        permission(f.root, true);
        for (const [file, content] of Object.entries({ 'main.widget': 'source', 'probe.case': 'case',
            'driver.cjs': 'process.exitCode = 0;\n' })) fs.writeFileSync(path.join(f.root, file), content);
        const declarationPath = path.join(f.root, 'validation.json');
        fs.writeFileSync(declarationPath, JSON.stringify({ schema_version: 1, recipes: [{
            id: 'project-check', purpose: 'test', executable: process.execPath,
            argv: ['driver.cjs', { target: 'selected' }], cwd: '.',
            inputs: [{ path: 'main.widget', role: 'source' }, { path: 'probe.case', role: 'test' },
                { path: 'driver.cjs', role: 'helper' }],
            targets: [{ id: 'selected', source: 'probe.case', selector: 'purchase' }],
            environment: {}, timeout_ms: 5000, max_attempts: 1, max_output_bytes: 4096,
            max_input_bytes: 65536, required_capabilities: [], result_format: 'opaque'
        }] }));
        handleSet({ targetRoot: f.root, projectValidationContract: declarationPath,
            operatorConfirmed: 'yes', operatorConfirmedAtUtc: new Date().toISOString(), json: true });
        const authority = readProjectValidationAuthority(f.root)!;
        const preflight = { project_validation: freezeProjectValidationAdmission(f.root).binding };
        const baseline = captureWorkflowConfigMigration(f.root);
        addManagedRule(f);
        recordWorkflowConfigMigration(f.root, baseline);
        assert.deepEqual(readProjectValidationAuthority(f.root)!.approved, authority.approved);
        assert.deepEqual(readProjectValidationFileRoles(f.root), { 'main.widget': 'source', 'probe.case': 'test' });
        assert.throws(() => currentProjectValidationAuthority(f.root, preflight), /refresh preflight/);
        assert.ok(currentProjectValidationAuthority(f.root, {
            project_validation: freezeProjectValidationAdmission(f.root).binding
        }));
        permission(f.root, false);
        permission(f.root, true);
        assert.deepEqual(readProjectValidationAuthority(f.root)!.approved, authority.approved);
        fs.appendFileSync(f.configPath, '\n');
        assert.throws(() => readProjectValidationAuthority(f.root), /current audited/);
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('initial command setup cannot authenticate replacement of configured project commands', () => {
    const f = fixture();
    try {
        syncWorkflowConfigWithTemplate(f.bundle);
        const initial = captureWorkflowConfigMigration(f.root);
        const config = JSON.parse(fs.readFileSync(f.configPath, 'utf8'));
        config.full_suite_validation.command = 'node tools/project-driver.cjs judge';
        fs.writeFileSync(f.configPath, JSON.stringify(config));
        recordWorkflowConfigMigration(f.root, initial, { initializeUnconfiguredCommands: true });
        const configured = captureWorkflowConfigMigration(f.root);
        const admittedAudit = fs.readFileSync(f.auditPath);
        config.full_suite_validation.command = 'npm test';
        fs.writeFileSync(f.configPath, JSON.stringify(config));
        assert.throws(() => recordWorkflowConfigMigration(f.root, configured,
            { initializeUnconfiguredCommands: true }), /existing project settings/);
        assert.deepEqual(fs.readFileSync(f.auditPath), admittedAudit);
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});
