import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildDefaultWorkflowConfig } from '../../../../src/core/workflow-config';
import { authenticateLocalCommitWorkflowAudit, resolveLocalCommitAvailability } from '../../../../src/core/auth/local-commit-availability';
import { createHash } from 'node:crypto';
import { handleSet } from '../../../../src/cli/commands/workflow/workflow-command-set';
import { handleWorkflow } from '../../../../src/cli/commands/workflow/workflow-command';
import { validateWorkflowConfig } from '../../../../src/schemas/config-artifacts';
import { startLocalUiServer } from '../../../../src/reports/ui';
import { hasUnsafeIgnoredWorkflowConfigCompatibilityBaseline } from '../../../../src/gates/workflow-config/workflow-config-work-compatibility';

function fixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-local-commit-'));
    const git = spawnSync('git', ['init', '--quiet'], { cwd: root, windowsHide: true });
    assert.equal(git.status, 0);
    const bundle = path.join(root, 'garda-agent-orchestrator');
    const config = path.join(bundle, 'live/config/workflow-config.json');
    fs.mkdirSync(path.dirname(config), { recursive: true });
    fs.writeFileSync(config, JSON.stringify(buildDefaultWorkflowConfig(), null, 2) + '\n');
    return { root, bundle, config };
}

function set(root: string, value: boolean, extra: Record<string, string> = {}) {
    return handleSet({ targetRoot: root, localCommitEnabled: String(value), json: true,
        operatorConfirmed: 'yes', operatorConfirmedAtUtc: new Date().toISOString(), ...extra });
}

test('indexed permission skips superseded history and bounds actual audit reads', (t) => {
    const f = fixture();
    const realFs = require('node:fs') as typeof fs;
    const read = realFs.readSync;
    try {
        const audit = path.join(f.bundle, 'runtime/workflow-config-audit.jsonl');
        fs.mkdirSync(path.dirname(audit), { recursive: true });
        fs.writeFileSync(audit, ('x'.repeat(1023) + '\n').repeat(8193));
        set(f.root, true);
        const receipt = JSON.parse(fs.readFileSync(path.join(f.bundle, 'live/config/local-commit-enablement-receipt.json'), 'utf8'));
        assert.equal(receipt.schema_version, 2);
        assert.equal(receipt.audit_record_byte_offset, 8193 * 1024);
        let bytesRead = 0;
        t.mock.method(realFs, 'readSync', (...args: Parameters<typeof read>) => {
            const count = Reflect.apply(read, realFs, args);
            bytesRead += count;
            return count;
        });
        assert.equal(resolveLocalCommitAvailability(f.root).enabled, true);
        assert.ok(bytesRead < 64 * 1024, 'authorization must not read the superseded 8 MiB prefix');
    } finally { t.mock.restoreAll(); fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('indexed permission rejects relocated grant and forged record offsets', () => {
    const f = fixture();
    try {
        set(f.root, true);
        const audit = path.join(f.bundle, 'runtime/workflow-config-audit.jsonl');
        const receiptPath = path.join(f.bundle, 'live/config/local-commit-enablement-receipt.json');
        const original = fs.readFileSync(audit, 'utf8');
        const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
        fs.writeFileSync(audit, '\n' + original);
        receipt.audit_record_byte_offset = 1;
        fs.writeFileSync(receiptPath, JSON.stringify(receipt));
        assert.equal(resolveLocalCommitAvailability(f.root).enabled, false, 'signed offset must reject a moved anchor');
        receipt.schema_version = 1;
        delete receipt.audit_record_byte_offset;
        fs.writeFileSync(receiptPath, JSON.stringify(receipt));
        assert.equal(resolveLocalCommitAvailability(f.root).enabled, false, 'receipt downgrade must not bypass the signed offset');
        receipt.schema_version = 2;
        receipt.audit_record_byte_offset = 2;
        fs.writeFileSync(receiptPath, JSON.stringify(receipt));
        assert.equal(resolveLocalCommitAvailability(f.root).enabled, false, 'mid-record offsets must fail closed');
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('permission verifies signed UTF-8 records across audit chunk boundaries', () => {
    const f = fixture();
    try {
        set(f.root, true);
        const audit = path.join(f.bundle, 'runtime/workflow-config-audit.jsonl');
        const grant = JSON.parse(fs.readFileSync(audit, 'utf8'));
        const record = authenticateLocalCommitWorkflowAudit(f.root, { event_source: 'workflow-config-set', command: 'workflow set',
            config_path: f.config, before_sha256: grant.after_sha256, after_sha256: grant.after_sha256,
            padding: 'x'.repeat(63000) + '€'.repeat(300) }, false);
        const line = JSON.stringify(record);
        assert.ok(Buffer.byteLength(line) < 64 * 1024);
        fs.appendFileSync(audit, '\n'.repeat(4096) + line + '\r\n');
        assert.ok(fs.statSync(audit).size > 64 * 1024);
        assert.equal(resolveLocalCommitAvailability(f.root).enabled, true);
        fs.writeFileSync(audit, fs.readFileSync(audit, 'utf8').replace('€', '£'));
        assert.equal(resolveLocalCommitAvailability(f.root).enabled, false, 'streaming must verify the complete signed record');
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('legacy permission receipts retain bounded authenticated verification', () => {
    const f = fixture();
    try {
        set(f.root, true);
        const audit = path.join(f.bundle, 'runtime/workflow-config-audit.jsonl');
        const receiptPath = path.join(f.bundle, 'live/config/local-commit-enablement-receipt.json');
        const record = JSON.parse(fs.readFileSync(audit, 'utf8'));
        delete record.audit_record_byte_offset;
        delete record.local_commit_authentication;
        const line = JSON.stringify(authenticateLocalCommitWorkflowAudit(f.root, record, false));
        fs.writeFileSync(audit, line + '\r\n');
        fs.writeFileSync(receiptPath, JSON.stringify({ schema_version: 1, event_source: 'local-commit-enablement-receipt',
            enabled: true, after_sha256: record.after_sha256, audit_record_sha256: createHash('sha256').update(line).digest('hex') }));
        assert.equal(resolveLocalCommitAvailability(f.root).enabled, true);
        fs.writeFileSync(audit, ('x'.repeat(1023) + '\n').repeat(8193) + line + '\n');
        assert.equal(resolveLocalCommitAvailability(f.root).enabled, false);
        set(f.root, true);
        assert.equal(resolveLocalCommitAvailability(f.root).enabled, true, 'fresh indexed grant must repair an oversized legacy scan');
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('permission audit rejects excessive records and incomplete tails without weakening revocation', () => {
    const f = fixture();
    try {
        set(f.root, true);
        const audit = path.join(f.bundle, 'runtime/workflow-config-audit.jsonl');
        const original = fs.readFileSync(audit, 'utf8');
        fs.appendFileSync(audit, ' '.repeat(64 * 1024 + 1) + '\n');
        assert.equal(resolveLocalCommitAvailability(f.root).enabled, false);
        fs.writeFileSync(audit, original + ' ');
        assert.equal(resolveLocalCommitAvailability(f.root).enabled, false);
        fs.writeFileSync(audit, original + '\n'.repeat(8 * 1024 * 1024));
        assert.equal(resolveLocalCommitAvailability(f.root).enabled, false);
        set(f.root, false);
        assert.equal(resolveLocalCommitAvailability(f.root).enabled, false);
        set(f.root, true);
        assert.equal(resolveLocalCommitAvailability(f.root).enabled, true);
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('local commit defaults and legacy migration deny authority', () => {
    const f = fixture();
    try {
        assert.equal(buildDefaultWorkflowConfig().local_commit.enabled, false);
        assert.equal(resolveLocalCommitAvailability(f.root).enabled, false);
        const config = JSON.parse(fs.readFileSync(f.config, 'utf8'));
        delete config.local_commit;
        fs.writeFileSync(f.config, JSON.stringify(config));
        assert.equal(resolveLocalCommitAvailability(f.root).enabled, false);
        fs.unlinkSync(f.config);
        assert.equal(resolveLocalCommitAvailability(f.root).enabled, false);
        fs.writeFileSync(f.config, '{invalid');
        assert.equal(resolveLocalCommitAvailability(f.root).enabled, false);
        assert.throws(() => validateWorkflowConfig({ ...buildDefaultWorkflowConfig(), local_commit: { enabled: true, authority: 'agent' } }), /not allowed/);
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('safe workflow compatibility accepts default and legacy OFF local commit settings', () => {
    const f = fixture();
    try {
        const configPath = 'garda-agent-orchestrator/live/config/workflow-config.json';
        assert.equal(hasUnsafeIgnoredWorkflowConfigCompatibilityBaseline(f.root, configPath), false);
        const config = JSON.parse(fs.readFileSync(f.config, 'utf8'));
        delete config.local_commit;
        fs.writeFileSync(f.config, JSON.stringify(config));
        assert.equal(hasUnsafeIgnoredWorkflowConfigCompatibilityBaseline(f.root, configPath), false);
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('safe workflow compatibility rejects ON and malformed local commit settings', () => {
    const f = fixture();
    try {
        for (const localCommit of [{ enabled: true }, { enabled: 'false' }, { enabled: false, authority: 'agent' }, {}, null]) {
            fs.writeFileSync(f.config, JSON.stringify({ ...buildDefaultWorkflowConfig(), local_commit: localCommit }));
            assert.equal(hasUnsafeIgnoredWorkflowConfigCompatibilityBaseline(f.root, 'garda-agent-orchestrator/live/config/workflow-config.json'), true);
        }
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('only an explicit audited enablement grants durable local commit permission', () => {
    const f = fixture();
    try {
        assert.throws(() => handleSet({ targetRoot: f.root, localCommitEnabled: 'true', json: true }), /operator confirmation/);
        set(f.root, true);
        assert.equal(resolveLocalCommitAvailability(f.root).enabled, true);
        assert.equal(resolveLocalCommitAvailability(f.root).auditedEnablement, true);
        handleSet({ targetRoot: f.root, fullSuiteGreenSummaryMaxLines: '7', json: true,
            operatorConfirmed: 'yes', operatorConfirmedAtUtc: new Date().toISOString() });
        assert.equal(resolveLocalCommitAvailability(f.root).enabled, true, 'audited unrelated settings must preserve the grant');
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('local commit rejects raw flags, forged receipts and foreign copied workspaces', () => {
    const f = fixture();
    const copy = fixture();
    try {
        const config = JSON.parse(fs.readFileSync(f.config, 'utf8'));
        config.local_commit.enabled = true;
        fs.writeFileSync(f.config, JSON.stringify(config));
        assert.equal(resolveLocalCommitAvailability(f.root).enabled, false);
        set(f.root, true);
        assert.equal(resolveLocalCommitAvailability(f.root).enabled, true, 'explicit same-value repair must be audited');
        fs.cpSync(f.bundle, copy.bundle, { recursive: true, force: true });
        fs.mkdirSync(path.join(copy.root, '.git/garda-private'), { recursive: true });
        fs.copyFileSync(path.join(f.root, '.git/garda-private/local-commit-key'), path.join(copy.root, '.git/garda-private/local-commit-key'));
        assert.equal(resolveLocalCommitAvailability(copy.root).enabled, false);
        const receipt = path.join(f.bundle, 'live/config/local-commit-enablement-receipt.json');
        const parsed = JSON.parse(fs.readFileSync(receipt, 'utf8'));
        parsed.audit_record_sha256 = 'a'.repeat(64);
        fs.writeFileSync(receipt, JSON.stringify(parsed));
        assert.equal(resolveLocalCommitAvailability(f.root).enabled, false);
    } finally {
        fs.rmSync(f.root, { recursive: true, force: true });
        fs.rmSync(copy.root, { recursive: true, force: true });
    }
});

test('revocation rejects replay of the complete prior config, receipt and audit', () => {
    const f = fixture();
    try {
        set(f.root, true);
        const snapshot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-local-commit-replay-'));
        try {
            fs.cpSync(f.bundle, snapshot, { recursive: true });
            set(f.root, false);
            assert.equal(resolveLocalCommitAvailability(f.root).enabled, false);
            fs.cpSync(snapshot, f.bundle, { recursive: true, force: true });
            assert.equal(resolveLocalCommitAvailability(f.root).enabled, false);
            set(f.root, true);
            assert.equal(resolveLocalCommitAvailability(f.root).enabled, true);
        } finally { fs.rmSync(snapshot, { recursive: true, force: true }); }
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('unaudited config edits and signed audit tampering fail closed', () => {
    const f = fixture();
    try {
        set(f.root, true);
        const config = JSON.parse(fs.readFileSync(f.config, 'utf8'));
        config.full_suite_validation.green_summary_max_lines = 19;
        fs.writeFileSync(f.config, JSON.stringify(config));
        assert.equal(resolveLocalCommitAvailability(f.root).enabled, false);
        set(f.root, true);
        const audit = path.join(f.bundle, 'runtime/workflow-config-audit.jsonl');
        fs.appendFileSync(audit, JSON.stringify({ event_source: 'workflow-config-set', command: 'workflow set', config_path: f.config, before_sha256: 'a'.repeat(64), after_sha256: 'b'.repeat(64) }) + '\n');
        assert.equal(resolveLocalCommitAvailability(f.root).enabled, false);
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('Settings UI rejects unconfirmed saves and reloads and revokes the authenticated workspace grant', async () => {
    const f = fixture();
    const server = await startLocalUiServer({ repoRoot: f.root, port: 0, actionsEnabled: true,
        actionRunner: async (action) => {
            const args = action.command.args;
            const value = (flag: string) => args[args.indexOf(flag) + 1];
            assert.ok(args.includes('--local-commit-enabled'));
            assert.equal(value('--mutation-source'), 'local-ui');
            handleSet({ targetRoot: f.root, localCommitEnabled: value('--local-commit-enabled'),
                operatorConfirmed: value('--operator-confirmed'), operatorConfirmedAtUtc: value('--operator-confirmed-at-utc'),
                mutationSource: value('--mutation-source'), json: true });
            return { exit_code: 0, signal: null, stdout: 'applied', stderr: '' };
        } });
    try {
        const html = await (await fetch(server.url)).text();
        const token = html.match(/const actionToken = "([^"]+)";/u)?.[1];
        assert.ok(token);
        const headers = { 'content-type': 'application/json', origin: server.url.slice(0, -1), 'x-garda-action-token': token };
        const change = (value: string, confirmation?: string) => fetch(`${server.url}api/settings`, {
            method: 'POST', headers, body: JSON.stringify({ setting_id: 'local-commit-enabled', value, mode: 'execute', confirmation }) });
        assert.equal((await change('true')).status, 409);
        assert.equal(resolveLocalCommitAvailability(f.root).enabled, false);
        assert.equal((await change('true', 'APPLY GARDA SETTING')).status, 200);
        assert.equal(resolveLocalCommitAvailability(f.root).enabled, true);
        const list = await (await fetch(`${server.url}api/settings`)).json() as { settings: Array<{ id: string; current_value: unknown; readiness?: { ready: boolean } }> };
        const setting = list.settings.find((entry) => entry.id === 'local-commit-enabled');
        assert.equal(setting?.current_value, true);
        assert.equal(setting?.readiness?.ready, true);
        assert.equal((await change('false', 'APPLY GARDA SETTING')).status, 200);
        assert.equal(resolveLocalCommitAvailability(f.root).enabled, false);
    } finally {
        await server.close();
        fs.rmSync(f.root, { recursive: true, force: true });
    }
});

test('native workflow CLI parses local commit on and off aliases with audited authority', () => {
    const f = fixture();
    try {
        const confirmation = ['--operator-confirmed', 'yes', '--operator-confirmed-at-utc', new Date().toISOString()];
        handleWorkflow(['set', '--target-root', f.root, '--local-commit', 'on', '--json', ...confirmation], { name: 'garda-agent-orchestrator', version: '1.4.4' });
        assert.equal(resolveLocalCommitAvailability(f.root).enabled, true);
        handleWorkflow(['set', '--target-root', f.root, '--local-commit-enabled', 'false', '--json', ...confirmation], { name: 'garda-agent-orchestrator', version: '1.4.4' });
        assert.equal(resolveLocalCommitAvailability(f.root).enabled, false);
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('same-value ON with a policy-only mutation repairs unaudited permission', () => {
    const f = fixture();
    try {
        const config = JSON.parse(fs.readFileSync(f.config, 'utf8'));
        config.local_commit.enabled = true;
        fs.writeFileSync(f.config, JSON.stringify(config, null, 2) + '\n');
        assert.equal(resolveLocalCommitAvailability(f.root).enabled, false);
        set(f.root, true, { optionalSkillSelectionMode: 'off' });
        assert.equal(resolveLocalCommitAvailability(f.root).enabled, true);
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('same-value OFF with a policy-only mutation rejects replay of an earlier ON grant', () => {
    const f = fixture();
    const snapshot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-local-commit-replay-'));
    try {
        set(f.root, true);
        fs.cpSync(f.bundle, snapshot, { recursive: true });
        const config = JSON.parse(fs.readFileSync(f.config, 'utf8'));
        config.local_commit.enabled = false;
        fs.writeFileSync(f.config, JSON.stringify(config, null, 2) + '\n');
        set(f.root, false, { optionalSkillSelectionMode: 'off' });
        assert.equal(resolveLocalCommitAvailability(f.root).enabled, false);
        fs.cpSync(snapshot, f.bundle, { recursive: true, force: true });
        assert.equal(resolveLocalCommitAvailability(f.root).enabled, false);
    } finally { fs.rmSync(snapshot, { recursive: true, force: true }); fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('OFF rejects unavailable Git metadata instead of falsely publishing revocation', () => {
    const f = fixture();
    const gitPath = path.join(f.root, '.git');
    const unavailablePath = path.join(f.root, '.git-unavailable');
    try {
        set(f.root, true);
        fs.renameSync(gitPath, unavailablePath);
        assert.throws(() => set(f.root, false), { code: 'ENOENT' });
        assert.equal(resolveLocalCommitAvailability(f.root).enabled, false);
        fs.renameSync(unavailablePath, gitPath);
        assert.equal(resolveLocalCommitAvailability(f.root).enabled, true, 'failed action must not claim durable revocation');
        set(f.root, false);
        assert.equal(resolveLocalCommitAvailability(f.root).enabled, false);
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('failed permission publication rejects the previous grant until fresh audited repair', (t) => {
    const f = fixture();
    const realFs = require('node:fs') as typeof fs;
    const rename = realFs.renameSync;
    try {
        set(f.root, true);
        t.mock.method(realFs, 'renameSync', (from: fs.PathLike, to: fs.PathLike) => {
            if (String(to).endsWith('protected-control-plane-manifest.json')) throw new Error('injected permission publication failure');
            return rename(from, to);
        });
        assert.throws(() => set(f.root, false), /injected permission publication failure/);
        assert.equal(resolveLocalCommitAvailability(f.root).enabled, false);
        t.mock.restoreAll();
        set(f.root, true);
        assert.equal(resolveLocalCommitAvailability(f.root).enabled, true);
    } finally { t.mock.restoreAll(); fs.rmSync(f.root, { recursive: true, force: true }); }
});
