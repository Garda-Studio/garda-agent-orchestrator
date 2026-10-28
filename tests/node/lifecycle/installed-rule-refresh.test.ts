import { runContractMigrations } from '../../../src/lifecycle/contract-migrations';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runInit } from '../../../src/materialization/init';
import { runReinit } from '../../../src/materialization/reinit';
import { runUpdate } from '../../../src/lifecycle/update';
import { runSnapshotRollback } from '../../../src/lifecycle/rollback';
import { runDoctor, formatDoctorResultCompact } from '../../../src/validators/doctor';
import { applyAssistantDefaults } from '../../../src/materialization/rule-materialization';

function findRoot(): string {
    let root = __dirname;
    while (!fs.existsSync(path.join(root, 'template'))) {
        const parent = path.dirname(root);
        if (parent === root) throw new Error('Repository root unavailable');
        root = parent;
    }
    return root;
}
const root = findRoot();
const owned = ['00-core.md', '35-strict-coding-rules.md', '70-security.md', '80-task-workflow.md', '90-skill-catalog.md'];
const mixed = ['40-commands.md', '50-structure-and-docs.md', '60-operating-rules.md'];
const fixtureRoot = path.join(root, 'tests/node/fixtures/online-store-installed-rules');

function workspace() {
    const targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-rule-refresh-'));
    const bundleRoot = path.join(targetRoot, 'garda-agent-orchestrator');
    fs.mkdirSync(bundleRoot);
    for (const name of ['VERSION', 'package.json']) fs.copyFileSync(path.join(root, name), path.join(bundleRoot, name));
    for (const name of ['template', 'bin']) fs.cpSync(path.join(root, name), path.join(bundleRoot, name), { recursive: true });
    fs.mkdirSync(path.join(bundleRoot, 'dist/src'), { recursive: true });
    fs.writeFileSync(path.join(bundleRoot, 'dist/src/index.js'), 'module.exports = {};');
    const live = path.join(bundleRoot, 'live/docs/agent-rules');
    fs.mkdirSync(live, { recursive: true });
    for (const file of [...owned, ...mixed]) fs.copyFileSync(path.join(fixtureRoot, file), path.join(live, file));
    fs.mkdirSync(path.join(bundleRoot, 'runtime'), { recursive: true });
    fs.mkdirSync(path.join(targetRoot, '.git/hooks'), { recursive: true });
    fs.writeFileSync(path.join(bundleRoot, 'runtime/init-answers.json'), JSON.stringify({
        AssistantLanguage: 'English', AssistantBrevity: 'concise', SourceOfTruth: 'Codex',
        EnforceNoAutoCommit: 'false', ClaudeOrchestratorFullAccess: 'false', TokenEconomyEnabled: 'true',
        CollectedVia: 'CLI_NONINTERACTIVE'
    }));
    return { targetRoot, bundleRoot, live };
}
function update(options: ReturnType<typeof workspace>) {
    return runUpdate({ ...options, skipVerify: true, skipManifestValidation: true });
}
function assertOwned(live: string, language = 'English', brevity = 'concise') {
    for (const file of owned) assert.equal(fs.readFileSync(path.join(live, file), 'utf8'),
        applyAssistantDefaults(fs.readFileSync(path.join(root, 'template/docs/agent-rules', file), 'utf8'), file, language, brevity), file);
}
function projectBytes(file: string): string {
    return '## Project ' + file + '\r\n\r\nKeep $& and `literal` exactly.  \r\n\r\n';
}

describe('installed rule refresh through real lifecycle entrypoints', () => {
    it('init and reinit refresh stale Garda rules, resolve preferences and back up the prior bytes', (t) => {
        const w = workspace(); t.after(() => fs.rmSync(w.targetRoot, { recursive: true, force: true }));
        const before = fs.readFileSync(path.join(w.live, '80-task-workflow.md'));
        const initialized = runInit({ ...w, sourceOfTruth: 'Codex' });
        assertOwned(w.live);
        const reports = fs.readdirSync(path.join(w.bundleRoot, 'runtime/update-reports'));
        const backupDir = reports.find(name => name.endsWith('-replaced-rules'))!;
        assert.ok(backupDir);
        assert.deepEqual(fs.readFileSync(path.join(w.bundleRoot, 'runtime/update-reports', backupDir, '80-task-workflow.md')), before);
        assert.match(fs.readFileSync(initialized.initReportPath, 'utf8'), /replaced-rules/u);
        for (const file of owned) fs.copyFileSync(path.join(fixtureRoot, file), path.join(w.live, file));
        runReinit({ ...w, overrides: { AssistantLanguage: 'German', AssistantBrevity: 'detailed' }, skipVerify: true, skipManifestValidation: true });
        assertOwned(w.live, 'German', 'detailed');
    });

    it('update refreshes historical mixed rules while retaining command maps, snapshots and project additions byte-for-byte; snapshot rollback restores every old rule', async (t) => {
        const w = workspace(); t.after(() => fs.rmSync(w.targetRoot, { recursive: true, force: true }));
        const old = new Map<string, Buffer>();
        for (const file of mixed) fs.appendFileSync(path.join(w.live, file), '\r\n' + projectBytes(file));
        for (const file of [...owned, ...mixed]) old.set(file, fs.readFileSync(path.join(w.live, file)));
        const commands = old.get('40-commands.md')!.toString();
        const commandMap = commands.slice(commands.indexOf('## Confirmed Application Command Map'), commands.indexOf('Primary entry point:'));
        const snapshot = commands.slice(commands.indexOf('## Project Discovery Snapshot'), commands.indexOf('### Manual Validation Evidence Selector', commands.indexOf('## Project Discovery Snapshot')));
        const result = update(w);
        assertOwned(w.live);
        for (const file of mixed) {
            const live = fs.readFileSync(path.join(w.live, file), 'utf8');
            assert.ok(live.includes(projectBytes(file)), file);
            assert.match(live, /<!-- garda:rule-section:/u);
        }
        const refreshed = fs.readFileSync(path.join(w.live, '40-commands.md'), 'utf8');
        assert.ok(refreshed.includes(commandMap));
        assert.ok(refreshed.includes(snapshot));
        assert.match(refreshed, /only after explicit operator approval/u);
        assert.ok(!refreshed.includes('human-commit --operator-confirmed'));
        const stack = fs.readFileSync(path.join(w.live, '60-operating-rules.md'), 'utf8');
        assert.ok(stack.includes('Preserve the explicit manual-only CI policy recorded in project memory and user instructions.'));
        const report = fs.readFileSync(path.join(w.targetRoot, result.updateReportPath), 'utf8');
        for (const file of [...owned, ...mixed]) assert.ok(report.includes(file), file);
        await runSnapshotRollback({ ...w, snapshotPath: result.rollbackSnapshotPath });
        for (const [file, bytes] of old) assert.deepEqual(fs.readFileSync(path.join(w.live, file)), bytes, file);
    });

    it('keeps unrecognized structures intact and reports warnings in update and doctor', (t) => {
        const w = workspace(); t.after(() => fs.rmSync(w.targetRoot, { recursive: true, force: true }));
        const custom = Buffer.from('# Bespoke commands\r\n\r\nDo not replace my application procedures.\r\n');
        fs.writeFileSync(path.join(w.live, '40-commands.md'), custom);
        const result = update(w);
        assert.deepEqual(fs.readFileSync(path.join(w.live, '40-commands.md')), custom);
        assert.match(fs.readFileSync(path.join(w.targetRoot, result.updateReportPath), 'utf8'), /40-commands.md.*preserved.*unrecognized/iu);
        const doctor = runDoctor({ targetRoot: w.targetRoot, sourceOfTruth: 'Codex' });
        assert.match(formatDoctorResultCompact(doctor), /40-commands.md.*preserved.*unrecognized/iu);
    });

    it('refreshes marked Garda sections on repeated update and preserves edited command slots and outside sections', (t) => {
        const w = workspace(); t.after(() => fs.rmSync(w.targetRoot, { recursive: true, force: true }));
        update(w);
        const file = path.join(w.live, '40-commands.md');
        let content = fs.readFileSync(file, 'utf8');
        const customCommand = '\x60\x60\x60bash\r\nnpm run application-check -- --literal "$&"\r\n\x60\x60\x60\r\n';
        content = content.replace(/(<!-- garda:project-command:test:start -->\r?\n)[\s\S]*?(<!-- garda:project-command:test:end -->)/u,
            (_raw, start: string, end: string) => start + customCommand + end);
        content = content.replace('only after explicit operator approval', 'STALE GARDA POLICY');
        fs.writeFileSync(file, content);
        fs.appendFileSync(file, projectBytes('custom-runbook'));
        update(w);
        const current = fs.readFileSync(file, 'utf8');
        assert.match(current, /only after explicit operator approval/u);
        assert.ok(!current.includes('STALE GARDA POLICY'));
        assert.ok(current.includes(projectBytes('custom-runbook')));
        assert.ok(current.includes(customCommand));
    });
});

describe('conservative installed-rule migration boundaries', () => {
    it('migrates standalone unmarked contract rules atomically without leaving orphan markers', (t) => {
        const w = workspace(); t.after(() => fs.rmSync(w.targetRoot, { recursive: true, force: true }));
        runContractMigrations({ rootPath: w.targetRoot });
        const file = path.join(w.live, '40-commands.md');
        const refreshed = fs.readFileSync(file, 'utf8');
        assert.match(refreshed, /only after explicit operator approval/u);
        assert.match(refreshed, /<!-- garda:rule-section:agent-gates:start -->/u);
        assert.match(refreshed, /<!-- garda:rule-section:agent-gates:end -->/u);
        update(w);
        assert.equal(fs.readFileSync(file, 'utf8'), refreshed);
    });

    it('preserves a custom command fence when both project ownership markers have been removed', (t) => {
        const w = workspace(); t.after(() => fs.rmSync(w.targetRoot, { recursive: true, force: true }));
        update(w);
        const file = path.join(w.live, '40-commands.md');
        const content = fs.readFileSync(file, 'utf8').replace(/^<!-- garda:project-command:test:(?:start|end) -->\r?\n/gmu, '');
        fs.writeFileSync(file, content);
        const result = update(w);
        assert.equal(fs.readFileSync(file, 'utf8'), content);
        assert.match(fs.readFileSync(path.join(w.targetRoot, result.updateReportPath), 'utf8'), /ambiguous project commands/u);
    });

    it('preserves unmarked rules when project additions make shipped text ownership ambiguous', (t) => {
        const w = workspace(); t.after(() => fs.rmSync(w.targetRoot, { recursive: true, force: true }));
        const file = path.join(w.live, '40-commands.md');
        const content = fs.readFileSync(file, 'utf8').replace('### Skill Packs\n', '### Skill Packs\n```bash\necho custom\n```\n');
        fs.writeFileSync(file, content);
        const result = update(w);
        assert.equal(fs.readFileSync(file, 'utf8'), content);
        assert.match(fs.readFileSync(path.join(w.targetRoot, result.updateReportPath), 'utf8'), /preserved.*unrecognized/u);
    });

    it('preserves invalid UTF-8 project bytes and warns instead of replacing them with decoded text', (t) => {
        const w = workspace(); t.after(() => fs.rmSync(w.targetRoot, { recursive: true, force: true }));
        const file = path.join(w.live, '60-operating-rules.md');
        const bytes = Buffer.concat([fs.readFileSync(file), Buffer.from('\n## Project bytes\n'), Buffer.from([0xff, 0xfe])]);
        fs.writeFileSync(file, bytes);
        const result = update(w);
        assert.deepEqual(fs.readFileSync(file), bytes);
        assert.match(fs.readFileSync(path.join(w.targetRoot, result.updateReportPath), 'utf8'), /invalid UTF-8/u);
    });
});

describe('legacy rule source byte preservation', () => {
    it('copies an unrecognized legacy source to a missing live destination without decoding its bytes', (t) => {
        const w = workspace(); t.after(() => fs.rmSync(w.targetRoot, { recursive: true, force: true }));
        const file = path.join(w.live, '40-commands.md');
        const bytes = Buffer.concat([fs.readFileSync(file), Buffer.from('\n## Project bytes\n'), Buffer.from([0xff])]);
        fs.unlinkSync(file);
        const legacy = path.join(w.targetRoot, 'docs/agent-rules');
        fs.mkdirSync(legacy, { recursive: true });
        fs.writeFileSync(path.join(legacy, '40-commands.md'), bytes);
        const result = runInit({ ...w, sourceOfTruth: 'Codex' });
        assert.deepEqual(fs.readFileSync(file), bytes);
        assert.match(fs.readFileSync(result.initReportPath, 'utf8'), /invalid UTF-8/u);
    });
});
