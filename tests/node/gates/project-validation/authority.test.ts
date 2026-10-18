import { it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { approveProjectValidationContract, parseApprovedValidationContract, readValidationFile, validationDigest } from '../../../../src/core/project-validation-identity';
import { freezeProjectValidationAuthority, freezeValidationRecipe, readProjectValidationAuthority, validationPaths } from '../../../../src/gates/project-validation/authority';
import { getClassificationConfig } from '../../../../src/gates/preflight/classify-change';
import { declaredFileRole } from '../../../../src/core/file-role-bindings';

it('projects both admitted source and test roles through ordinary classification without helper authority', () => {
    const f = fixture();
    try {
        admitted(f);
        const config = getClassificationConfig(f.root);
        assert.equal(declaredFileRole('product.any', config.file_roles), 'source');
        assert.equal(declaredFileRole('specifications/case.unknown', config.file_roles), 'test');
        assert.equal(declaredFileRole('driver.cjs', config.file_roles), undefined);
        fs.appendFileSync(f.configPath, ' ');
        assert.throws(() => getClassificationConfig(f.root), /authority|audited/u);
    } finally { f.clean(); }
});

function fixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-recipe-authority-'));
    const bundle = path.join(root, 'garda-agent-orchestrator');
    fs.mkdirSync(path.join(bundle, 'live/config'), { recursive: true });
    fs.mkdirSync(path.join(bundle, 'runtime/reviews'), { recursive: true });
    fs.mkdirSync(path.join(root, 'specifications'));
    for (const [name, text] of [['product.any', 'implementation'], ['specifications/case.unknown', 'test'], ['driver.cjs', 'helper']]) fs.writeFileSync(path.join(root, name), text);
    const configPath = path.join(bundle, 'live/config/workflow-config.json');
    const auditPath = path.join(bundle, 'runtime/workflow-config-audit.jsonl');
    const declaration = { schema_version: 1, recipes: [{ id: 'recipe', purpose: 'test', executable: process.execPath, argv: ['driver.cjs', { target: 'case' }], cwd: '.',
        inputs: [{ path: 'product.any', role: 'source' }, { path: 'specifications/case.unknown', role: 'test' }, { path: 'driver.cjs', role: 'helper' }],
        targets: [{ id: 'case', source: 'specifications/case.unknown', selector: 'проверка' }], environment: {}, timeout_ms: 5000,
        max_attempts: 1, max_output_bytes: 65536, max_input_bytes: 65536, required_capabilities: [], result_format: 'tap' }] };
    return { root, bundle, configPath, auditPath, declaration, clean: () => fs.rmSync(root, { recursive: true, force: true }) };
}
function admitted(f: ReturnType<typeof fixture>) {
    const approved = approveProjectValidationContract(f.root, f.declaration);
    const config = JSON.stringify({ project_validation: approved });
    fs.writeFileSync(f.configPath, config);
    const audit = { event_source: 'workflow-config-set', mutation_source: 'cli', config_path: f.configPath, after_sha256: validationDigest(config),
        changed_fields: ['project_validation'], project_validation_admission_sha256: validationDigest(approved) };
    fs.writeFileSync(f.auditPath, JSON.stringify(audit) + '\n');
    const preflight = { task_id: 'T-1', changed_files: ['product.any', 'specifications/case.unknown'], project_validation: freezeProjectValidationAuthority(f.root) };
    fs.writeFileSync(path.join(f.bundle, 'runtime/reviews/T-1-preflight.json'), JSON.stringify(preflight));
    return { approved, config, audit, preflight };
}

it('freezes unfamiliar-layout recipe inputs and executable identity without launching the tool', () => {
    const f = fixture();
    try {
        const a = admitted(f), frozen = freezeValidationRecipe(f.root, 'T-1', 'recipe');
        assert.equal(frozen.tool.sha256, a.approved.tools.recipe.sha256);
        assert.deepEqual(frozen.inputs.map((input) => input.path), ['product.any', 'specifications/case.unknown', 'driver.cjs']);
        assert.equal(frozen.inputs[0].sha256, validationDigest('implementation'));
        const { snapshot_sha256, ...payload } = frozen;
        assert.equal(snapshot_sha256, validationDigest(payload));
        assert.equal(fs.existsSync(path.join(f.bundle, 'runtime/task-events/T-1.jsonl')), false);
    } finally { f.clean(); }
});
it('preserves approval and reconstruction digests for helpers declared out of sorted order', () => {
    const f = fixture();
    try {
        fs.writeFileSync(path.join(f.root, 'a.cjs'), 'second helper');
        f.declaration.recipes[0].inputs.push({ path: 'a.cjs', role: 'helper' });
        const a = admitted(f);
        assert.equal(validationDigest(parseApprovedValidationContract(a.approved)), validationDigest(a.approved));
        assert.doesNotThrow(() => freezeValidationRecipe(f.root, 'T-1', 'recipe'));
    } finally { f.clean(); }
});
it('rejects oversized input before reading bytes and permits an exact byte bound', () => {
    const f = fixture();
    try {
        const read = () => Reflect.apply(readValidationFile, undefined, [f.root, 'product.any', 3]);
        assert.throws(read, /bound|Invalid validation input/u);
        const exact = Reflect.apply(readValidationFile, undefined, [f.root, 'product.any', 14]);
        assert.equal(exact.bytes.toString(), 'implementation');
    } finally { f.clean(); }
});
it('rejects shared config identity even when no project validation property is present', () => {
    const f = fixture();
    try {
        fs.writeFileSync(path.join(f.root, 'shared.json'), '{}'); fs.linkSync(path.join(f.root, 'shared.json'), f.configPath);
        assert.throws(() => readProjectValidationAuthority(f.root), /hard-linked|Invalid validation input/u);
    } finally { f.clean(); }
});
it('rejects growth during the actual descriptor read and retains the input', () => {
    const f = fixture(), fileSystem = require('node:fs') as typeof fs, original = fileSystem.readSync;
    try {
        const file = path.join(f.root, 'product.any'), inode = fs.statSync(file, { bigint: true }).ino; let changed = false;
        fileSystem.readSync = ((...args: Parameters<typeof original>) => {
            const count = Reflect.apply(original, fileSystem, args);
            if (!changed && fs.fstatSync(args[0], { bigint: true }).ino === inode) { changed = true; fs.appendFileSync(file, 'changed'); }
            return count;
        }) as typeof original;
        assert.throws(() => readValidationFile(f.root, 'product.any'), /changed during read/u);
        assert.equal(changed, true); assert.equal(fs.readFileSync(file, 'utf8'), 'implementationchanged');
    } finally { fileSystem.readSync = original; f.clean(); }
});
it('rejects mismatched audited config and missing recipe admission', () => {
    const f = fixture();
    try {
        const a = admitted(f);
        for (const audit of [{ ...a.audit, after_sha256: '0'.repeat(64) }, { ...a.audit, changed_fields: [] }, { ...a.audit, mutation_source: 'agent' }, { ...a.audit, project_validation_admission_sha256: '0'.repeat(64) }]) {
            fs.writeFileSync(f.auditPath, JSON.stringify(audit) + '\n'); assert.throws(() => freezeProjectValidationAuthority(f.root), /audited|admission/u);
        }
        const unsupported = { ...a.audit, mutation_source: 'agent', changed_fields: ['unrelated'], before_sha256: a.audit.after_sha256, after_sha256: validationDigest(a.config + ' ') };
        const restored = { ...unsupported, before_sha256: unsupported.after_sha256, after_sha256: a.audit.after_sha256 };
        fs.writeFileSync(f.auditPath, [a.audit, unsupported, restored].map((value) => JSON.stringify(value)).join('\n'));
        assert.throws(() => freezeProjectValidationAuthority(f.root), /audited|admission/u);
    } finally { f.clean(); }
});
it('rejects an oversized audit before allocating its file contents', () => {
    const f = fixture(), fileSystem = require('node:fs') as typeof fs, original = fileSystem.readSync;
    try {
        const a = admitted(f); fs.truncateSync(f.auditPath, 8 * 1024 * 1024 + 1);
        const auditInode = fs.statSync(f.auditPath, { bigint: true }).ino; let reads = 0;
        fileSystem.readSync = ((...args: Parameters<typeof original>) => {
            if (typeof args[0] === 'number' && fs.fstatSync(args[0], { bigint: true }).ino === auditInode) reads++;
            return Reflect.apply(original, fileSystem, args);
        }) as typeof original;
        assert.throws(() => readProjectValidationAuthority(f.root), /bound|Invalid validation input/u); assert.equal(reads, 0);
        fs.writeFileSync(f.auditPath, JSON.stringify(a.audit));
        assert.doesNotThrow(() => readProjectValidationAuthority(f.root)); assert.ok(reads > 0);
    } finally { fileSystem.readSync = original; f.clean(); }
});
it('rejects stale recipe admission and broken config mutation chains', () => {
    const f = fixture();
    try {
        const a = admitted(f);
        fs.appendFileSync(f.auditPath, JSON.stringify({ ...a.audit, project_validation_admission_sha256: '0'.repeat(64) }) + '\n');
        assert.throws(() => freezeProjectValidationAuthority(f.root), /admission/u);
        const config = JSON.stringify({ project_validation: a.approved, unrelated: true }); fs.writeFileSync(f.configPath, config);
        const next = { ...a.audit, changed_fields: ['unrelated'], before_sha256: '0'.repeat(64), after_sha256: validationDigest(config) };
        fs.writeFileSync(f.auditPath, [a.audit, next].map((value) => JSON.stringify(value)).join('\n'));
        assert.throws(() => freezeProjectValidationAuthority(f.root), /chain|audited/u);
        next.before_sha256 = a.audit.after_sha256;
        fs.writeFileSync(f.auditPath, [a.audit, next].map((value) => JSON.stringify(value)).join('\n'));
        assert.equal(readProjectValidationAuthority(f.root)?.sha256, next.after_sha256);
        const missingAdmission = { ...a.audit };
        delete (missingAdmission as Partial<typeof a.audit>).after_sha256;
        const missingNext = { ...next };
        delete (missingNext as Partial<typeof next>).before_sha256;
        fs.writeFileSync(f.auditPath, [missingAdmission, missingNext].map((value) => JSON.stringify(value)).join('\n'));
        assert.throws(() => freezeProjectValidationAuthority(f.root), /chain|audited/u);
    } finally { f.clean(); }
});
it('rejects dangling linked scope while retaining genuine deleted paths', () => {
    const f = fixture();
    try {
        const a = admitted(f), preflightPath = path.join(f.bundle, 'runtime/reviews/T-1-preflight.json');
        a.preflight.changed_files.push('absent.any'); fs.writeFileSync(preflightPath, JSON.stringify(a.preflight));
        const frozen = freezeValidationRecipe(f.root, 'T-1', 'recipe');
        assert.equal(frozen.scope_sha256, validationDigest([frozen.inputs[0], frozen.inputs[1], { path: 'absent.any', deleted: true }]));
        fs.symlinkSync(path.join(f.root, 'missing-directory'), path.join(f.root, 'alias'), 'junction');
        a.preflight.changed_files.push('alias/missing.any'); fs.writeFileSync(preflightPath, JSON.stringify(a.preflight));
        assert.throws(() => freezeValidationRecipe(f.root, 'T-1', 'recipe'), /symlink|junction/ui);
    } finally { f.clean(); }
});
it('rejects changed helpers, changed executables, foreign preflights and stale frozen authority', () => {
    const f = fixture();
    try {
        const a = admitted(f), preflightPath = path.join(f.bundle, 'runtime/reviews/T-1-preflight.json');
        fs.appendFileSync(path.join(f.root, 'driver.cjs'), 'changed'); assert.throws(() => freezeValidationRecipe(f.root, 'T-1', 'recipe'), /dependency changed/u);
        fs.writeFileSync(path.join(f.root, 'driver.cjs'), 'helper');
        a.approved.tools.recipe.sha256 = '0'.repeat(64);
        const config = JSON.stringify({ project_validation: a.approved }); fs.writeFileSync(f.configPath, config);
        fs.writeFileSync(f.auditPath, JSON.stringify({ ...a.audit, after_sha256: validationDigest(config), project_validation_admission_sha256: validationDigest(a.approved) }));
        a.preflight.project_validation = freezeProjectValidationAuthority(f.root);
        fs.writeFileSync(preflightPath, JSON.stringify(a.preflight)); assert.throws(() => freezeValidationRecipe(f.root, 'T-1', 'recipe'), /executable identity changed/u);
        fs.writeFileSync(preflightPath, JSON.stringify({ ...a.preflight, task_id: 'foreign' })); assert.throws(() => freezeValidationRecipe(f.root, 'T-1', 'recipe'), /Foreign/u);
        fs.writeFileSync(preflightPath, JSON.stringify({ ...a.preflight, project_validation: { authority_sha256: '0'.repeat(64) } })); assert.throws(() => freezeValidationRecipe(f.root, 'T-1', 'recipe'), /authority changed/u);
    } finally { f.clean(); }
});
it('reconstructs exact approved identity maps and rejects mismatched paths and malformed identities', () => {
    const f = fixture();
    try {
        const approved = approveProjectValidationContract(f.root, f.declaration);
        assert.deepEqual(JSON.parse(JSON.stringify(parseApprovedValidationContract(approved))), JSON.parse(JSON.stringify(approved)));
        for (const mutate of [(value: typeof approved) => { value.tools.recipe.path = 'foreign'; }, (value: typeof approved) => { value.dependencies['driver.cjs'].path = 'foreign'; },
            (value: typeof approved) => { value.dependencies['driver.cjs'].identity = ''; }, (value: typeof approved) => { delete value.tools.recipe; },
            (value: typeof approved) => { value.tools.recipe.sha256 = [value.tools.recipe.sha256] as unknown as string; }]) {
            const value = JSON.parse(JSON.stringify(approved)) as typeof approved; mutate(value); assert.throws(() => parseApprovedValidationContract(value), /identity|identities/u);
        }
    } finally { f.clean(); }
});
it('preserves an absent declaration and rejects invalid task identities and escaping input paths', () => {
    const f = fixture();
    try {
        assert.equal(readProjectValidationAuthority(f.root), null); fs.writeFileSync(f.configPath, '{}'); assert.equal(freezeProjectValidationAuthority(f.root), undefined);
        assert.throws(() => validationPaths(f.root, '../foreign'), /task identity/u);
        assert.throws(() => readValidationFile(f.root, '../outside'), /canonical|outside/u);
    } finally { f.clean(); }
});
