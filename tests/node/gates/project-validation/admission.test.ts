import { it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { buildDefaultWorkflowConfig } from '../../../../src/core/workflow-config';
import { localCommitReceiptPath, resolveLocalCommitAvailability } from '../../../../src/core/auth/local-commit-availability';
import { approveProjectValidationContract, validationDigest } from '../../../../src/core/project-validation-identity';
import { validateWorkflowConfig } from '../../../../src/schemas/config-artifacts-workflow';
import { handleWorkflow } from '../../../../src/cli/commands/workflow-command';
import { runClassifyChangeCommand } from '../../../../src/cli/commands/gates';
import { currentProjectValidationAuthority, freezeProjectValidationAuthority, readProjectValidationAuthority } from '../../../../src/gates/project-validation/authority';
import { createTempRepo, initializeGitRepo, loadTaskEntryRulePack, runEnterTaskMode, runHandshakeForTask, runShellSmokeForTask,
    seedInitAnswers, seedTaskQueue } from '../../cli/commands/gates/preflight/gates-preflight-fixtures';

function fixture() {
    const root = createTempRepo(), bundle = path.join(root, 'garda-agent-orchestrator');
    const config = path.join(bundle, 'live/config/workflow-config.json'), audit = path.join(bundle, 'runtime/workflow-config-audit.jsonl');
    fs.mkdirSync(path.dirname(config), { recursive: true });
    fs.writeFileSync(config, JSON.stringify(buildDefaultWorkflowConfig(), null, 2) + '\n');
    fs.mkdirSync(path.join(root, 'specifications'));
    fs.writeFileSync(path.join(root, 'product.any'), 'implementation');
    fs.writeFileSync(path.join(root, 'specifications/case.unknown'), 'case');
    fs.writeFileSync(path.join(root, 'driver.cjs'), 'require("node:fs").writeFileSync("EXECUTED", "unexpected")');
    const declaration = { schema_version: 1, recipes: [{ id: 'recipe', purpose: 'test', executable: process.execPath,
        argv: ['driver.cjs', { target: 'case' }], cwd: '.', inputs: [{ path: 'product.any', role: 'source' },
            { path: 'specifications/case.unknown', role: 'test' }, { path: 'driver.cjs', role: 'helper' }],
        targets: [{ id: 'case', source: 'specifications/case.unknown', selector: 'declared case' }], environment: {},
        timeout_ms: 5000, max_attempts: 1, max_output_bytes: 65536, max_input_bytes: 65536, required_capabilities: [], result_format: 'tap' }] };
    fs.writeFileSync(path.join(root, 'recipes.json'), JSON.stringify(declaration));
    seedInitAnswers(root);
    initializeGitRepo(root);
    return { root, bundle, config, audit, declaration, clean: () => fs.rmSync(root, { recursive: true, force: true }) };
}
function set(f: ReturnType<typeof fixture>, args: string[], confirmed = true) {
    return handleWorkflow(['set', '--target-root', f.root, '--json', ...args,
        ...(confirmed ? ['--operator-confirmed', 'yes', '--operator-confirmed-at-utc', new Date().toISOString()] : [])],
    { name: 'garda-agent-orchestrator', version: '1.0.0' });
}
function records(f: ReturnType<typeof fixture>): Array<Record<string, unknown>> {
    return fs.readFileSync(f.audit, 'utf8').trim().split(/\r?\n/u).map((line) => JSON.parse(line) as Record<string, unknown>);
}
function readConfig(f: ReturnType<typeof fixture>): Record<string, unknown> { return JSON.parse(fs.readFileSync(f.config, 'utf8')); }
function preflight(f: ReturnType<typeof fixture>): Record<string, unknown> {
    seedTaskQueue(f.root, 'T-1', 'TODO', 'default', 'Required reviews: code, security, test.', 'Change authorization flow');
    initializeGitRepo(f.root);
    runEnterTaskMode({ repoRoot: f.root, taskId: 'T-1', entryMode: 'EXPLICIT_TASK_EXECUTION', requestedDepth: 2,
        taskSummary: 'Change authorization flow', provider: 'Codex' });
    loadTaskEntryRulePack(f.root, 'T-1'); runHandshakeForTask(f.root, 'T-1'); runShellSmokeForTask(f.root, 'T-1');
    fs.appendFileSync(path.join(f.root, 'src/app.ts'), '\nexport const permission = true;\n');
    const outputPath = path.join(f.bundle, 'runtime/reviews/T-1-preflight.json');
    runClassifyChangeCommand({ repoRoot: f.root, taskId: 'T-1', taskIntent: 'Change authorization flow', outputPath,
        changedFiles: ['src/app.ts'], emitMetrics: false });
    return JSON.parse(fs.readFileSync(outputPath, 'utf8')) as Record<string, unknown>;
}

it('reconstructs approved recipe schema and rejects malformed identity maps without changing other settings', () => {
    const f = fixture();
    try {
        const approved = approveProjectValidationContract(f.root, f.declaration);
        const config = { ...buildDefaultWorkflowConfig(), project_validation: approved };
        const parsed = validateWorkflowConfig(config);
        assert.equal(validationDigest(parsed.project_validation), validationDigest(approved));
        for (const invalid of [{ ...approved, tools: {} }, { ...approved, unexpected: true }, f.declaration]) {
            assert.throws(() => validateWorkflowConfig({ ...config, project_validation: invalid }), /validation|identit|contract/u);
        }
        const { project_validation, ...rest } = parsed;
        assert.deepEqual(rest, validateWorkflowConfig(buildDefaultWorkflowConfig()));
    } finally { f.clean(); }
});
it('admits a declared recipe through the real audited setter while preserving the authenticated commit grant and policy floors', () => {
    const f = fixture();
    try {
        set(f, ['--local-commit-enabled', 'true']);
        const before = readConfig(f), receipt = fs.readFileSync(localCommitReceiptPath(f.root));
        assert.equal(resolveLocalCommitAvailability(f.root).enabled, true);
        fs.renameSync(path.join(f.root, 'recipes.json'), path.join(f.root, 'specifications/recipes.json'));
        set(f, ['--project-validation-contract', 'specifications/recipes.json']);
        const after = readConfig(f), authority = readProjectValidationAuthority(f.root)!;
        assert.equal(authority.sha256, validationDigest(fs.readFileSync(f.config)));
        assert.equal(records(f).at(-1)!.project_validation_admission_sha256, validationDigest(authority.approved));
        const { project_validation, ...rest } = after;
        assert.deepEqual(rest, before); assert.deepEqual(fs.readFileSync(localCommitReceiptPath(f.root)), receipt);
        assert.equal(resolveLocalCommitAvailability(f.root).enabled, true);
        assert.equal(fs.existsSync(path.join(f.root, 'EXECUTED')), false);
    } finally { f.clean(); }
});
it('requires explicit confirmation for admission and leaves rejected mutations unchanged', () => {
    const f = fixture();
    try {
        const before = fs.readFileSync(f.config);
        assert.throws(() => set(f, ['--project-validation-contract', 'recipes.json'], false), /operator|confirm/u);
        assert.deepEqual(fs.readFileSync(f.config), before); assert.equal(fs.existsSync(f.audit), false);
    } finally { f.clean(); }
});
it('audits an explicit identical admission again and preserves its chain through unrelated settings', () => {
    const f = fixture();
    try {
        set(f, ['--project-validation-contract', 'recipes.json']);
        const before = fs.readFileSync(f.config), count = records(f).length;
        const result = set(f, ['--project-validation-contract', 'recipes.json']);
        assert.ok(result && result.action === 'set'); assert.equal(result.changed, false);
        assert.deepEqual(fs.readFileSync(f.config), before); assert.equal(records(f).length, count + 1);
        assert.deepEqual(records(f).at(-1)!.changed_fields, ['project_validation']);
        assert.doesNotThrow(() => readProjectValidationAuthority(f.root));
        set(f, ['--full-suite-green-summary-max-lines', '7']);
        assert.doesNotThrow(() => readProjectValidationAuthority(f.root));
        assert.equal(records(f).at(-1)!.project_validation_admission_sha256, undefined);
    } finally { f.clean(); }
});
it('rolls back invalid declarations and escaping declaration paths without publishing admission', () => {
    const f = fixture();
    try {
        const before = fs.readFileSync(f.config);
        fs.writeFileSync(path.join(f.root, 'recipes.json'), '{broken');
        for (const source of ['recipes.json', '../outside.json']) {
            assert.throws(() => set(f, ['--project-validation-contract', source]));
            assert.deepEqual(fs.readFileSync(f.config), before); assert.equal(fs.existsSync(f.audit), false);
        }
        assert.equal(fs.existsSync(path.join(f.root, 'EXECUTED')), false);
    } finally { f.clean(); }
});
it('rejects stale authority after native preflight binding while retaining required review floors', () => {
    const f = fixture();
    try {
        set(f, ['--project-validation-contract', 'recipes.json']);
        const frozen = preflight(f);
        assert.deepEqual(frozen.project_validation, freezeProjectValidationAuthority(f.root));
        assert.ok(frozen.project_validation); assert.equal(frozen.task_id, 'T-1');
        const required = frozen.required_reviews as Record<string, boolean>;
        assert.equal(required.code, true); assert.equal(required.security, true); assert.equal(required.test, true);
        assert.doesNotThrow(() => currentProjectValidationAuthority(f.root, frozen));
        set(f, ['--full-suite-green-summary-max-lines', '8']);
        assert.throws(() => currentProjectValidationAuthority(f.root, frozen), /refresh preflight/u);
        assert.equal(fs.existsSync(path.join(f.root, 'EXECUTED')), false);
    } finally { f.clean(); }
});
it('keeps legacy native preflight compatible when no recipe has been admitted', () => {
    const f = fixture();
    try {
        const frozen = preflight(f);
        assert.equal(frozen.project_validation, undefined); assert.equal(readProjectValidationAuthority(f.root), null);
        assert.equal((frozen.required_reviews as Record<string, boolean>).code, true);
    } finally { f.clean(); }
});
