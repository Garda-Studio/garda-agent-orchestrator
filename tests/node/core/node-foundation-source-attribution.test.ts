import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import ts from 'typescript';
import { resolveNodeFoundationFailureSource } from '../../../src/core/validation/node-foundation-source-attribution';
import { validationDigest } from '../../../src/core/project-validation-identity';
import { buildValidationResult, detectOutOfScopeFailures } from '../../../src/gates/full-suite/full-suite-validation-results';
import { loadFullSuiteValidationConfig } from '../../../src/gates/full-suite/full-suite-validation-config';

function fixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-compiled-scope-'));
    const source = 'checks/owned.test.ts', emitted = '.node-build/checks/owned.test.js';
    fs.mkdirSync(path.join(root, 'checks'));
    const input = 'import { strict as assert } from "node:assert";\nimport { test } from "node:test";\ntest("owned assertion failure", () => assert.equal(1, 2));\n';
    fs.writeFileSync(path.join(root, source), input);
    fs.writeFileSync(path.join(root, 'tsconfig.tests.json'), JSON.stringify({ compilerOptions: {
        target: 'ES2022', module: 'CommonJS', moduleResolution: 'Node', moduleDetection: 'force',
        rootDir: '.', outDir: '.node-build', sourceMap: true, esModuleInterop: true
    }, include: ['checks/**/*.ts'] }));
    const config = ts.readConfigFile(path.join(root, 'tsconfig.tests.json'), ts.sys.readFile);
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root, {}, path.join(root, 'tsconfig.tests.json'));
    const program = ts.createProgram(parsed.fileNames, parsed.options);
    assert.equal(program.emit().emitSkipped, false);
    const inputs = [source, 'tsconfig.tests.json'].map(file => {
        const bytes = fs.readFileSync(path.join(root, file));
        return { path: file, size: bytes.length, sha256: validationDigest(bytes) };
    });
    fs.writeFileSync(path.join(root, '.node-build/node-foundation-manifest.json'), JSON.stringify({
        files: ['checks/owned.test.js'], inputFingerprint: { typescriptVersion: ts.version, files: inputs }
    }));
    return { root, source, emitted };
}

test('attributes an actual failed emitted test to its reconstructed source without blaming its launcher', t => {
    const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
    let failed: (Error & { status: number; stdout: string; stderr: string }) | undefined;
    const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
    try { execFileSync(process.execPath, ['--test', '--test-reporter=spec', f.emitted], { cwd: f.root, env, encoding: 'utf8', stdio: 'pipe' }); }
    catch (error) { failed = error as typeof failed; }
    assert.equal(failed?.status, 1);
    assert.match(failed!.stdout, /owned assertion failure/);
    const output = `${failed!.stdout}\n${failed!.stderr}\n${failed!.stack}`.split(/\r?\n/u);
    assert.equal(resolveNodeFoundationFailureSource(f.root, f.emitted), f.source);
    assert.equal(detectOutOfScopeFailures(output, [f.source], f.root), false);
    const config = { ...loadFullSuiteValidationConfig(f.root), enabled: true, out_of_scope_failure_policy: 'AUDIT_AND_WARN' as const };
    const result = buildValidationResult(config, 1, false, output, null, [f.source], undefined, f.root);
    assert.equal(result.status, 'FAILED', 'An owned assertion failure cannot become a warning.');
    assert.equal(result.out_of_scope_failure_detected, false);
    fs.writeFileSync(path.join(f.root, 'checks/foreign.custom'), 'foreign source');
    const foreign = 'error at checks/foreign.custom:3';
    assert.equal(buildValidationResult(config, 1, false, [foreign], null, [f.source], undefined, f.root).status, 'WARNED');
    assert.equal(buildValidationResult(config, 1, false, [...output, foreign], null, [f.source], undefined, f.root).status, 'FAILED');
    assert.equal(buildValidationResult({ ...config, out_of_scope_failure_policy: 'AUDIT_AND_BLOCK' }, 1, false,
        [foreign], null, [f.source], undefined, f.root).status, 'FAILED');
    assert.equal(buildValidationResult(config, 1, false,
        Array.from({ length: 129 }, (_, index) => `error at checks/foreign-${index}.custom:3`), null, [f.source]).status, 'FAILED',
    'A bounded partial attribution cannot turn a failed suite into a warning.');
});

test('rejects stale, forged and ambiguous emitted-source relations and keeps their failures blocking', t => {
    const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
    const outputFile = path.join(f.root, f.emitted), mapFile = `${outputFile}.map`, sourceFile = path.join(f.root, f.source);
    const originalOutput = fs.readFileSync(outputFile), originalMap = fs.readFileSync(mapFile), originalSource = fs.readFileSync(sourceFile);
    const map = JSON.parse(originalMap.toString('utf8'));
    fs.writeFileSync(path.join(f.root, 'checks/alias.test.ts'), originalSource);
    const mutations = [
        () => fs.appendFileSync(outputFile, '\n// changed emitted output'),
        () => fs.appendFileSync(sourceFile, '\n// changed source'),
        () => fs.writeFileSync(mapFile, JSON.stringify({ ...map, sources: [map.sources[0], map.sources[0]] })),
        () => fs.writeFileSync(mapFile, JSON.stringify({ ...map, sources: ['../../../checks/alias.test.ts'] })),
        () => fs.writeFileSync(mapFile, JSON.stringify({ ...map, sources: ['../../../../outside.ts'] })),
        () => fs.writeFileSync(mapFile, JSON.stringify({ ...map, mappings: '' }))
    ];
    for (const mutate of mutations) {
        fs.writeFileSync(outputFile, originalOutput); fs.writeFileSync(mapFile, originalMap); fs.writeFileSync(sourceFile, originalSource);
        mutate();
        assert.equal(resolveNodeFoundationFailureSource(f.root, f.emitted), null);
        const result = buildValidationResult({ ...loadFullSuiteValidationConfig(f.root), enabled: true,
            out_of_scope_failure_policy: 'AUDIT_AND_WARN' }, 1, false, [`test at ${f.emitted}:7:1`], null, [f.source], undefined, f.root);
        assert.equal(result.status, 'FAILED');
    }
    assert.equal(detectOutOfScopeFailures(['error at checks/owned.test.ts.extra:1'], [f.source]), true,
        'A path substring is not a source identity.');
});
