import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runInitConfigStage } from '../../../src/materialization/init/init-config-stage';
import { getProjectDiscovery } from '../../../src/materialization/project-discovery';

function withConfigStage(
    name: string, template: Record<string, unknown>, existing: string | null,
    check: (fixture: { file: string; run: (dryRun?: boolean) => void }) => void
): void {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-config-identity-'));
    try {
        const templateRoot = path.join(root, 'template');
        const liveRoot = path.join(root, 'live');
        for (const directory of [templateRoot, liveRoot]) {
            fs.mkdirSync(path.join(directory, 'config'), { recursive: true });
        }
        fs.writeFileSync(path.join(templateRoot, 'config', name + '.json'), JSON.stringify(template));
        const file = path.join(liveRoot, 'config', name + '.json');
        if (existing !== null) fs.writeFileSync(file, existing);
        check({ file, run(dryRun = false) {
            runInitConfigStage({ targetRoot: root, templateRoot, liveRoot,
                workflowConfigExistedBeforeRun: false, preserveLegacyWorkflowConfigOmission: false,
                discovery: getProjectDiscovery(root), preservedCompileGateCommand: null,
                tokenEconomyEnabled: true, dryRun });
        } });
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

describe('managed configuration byte identity', () => {
    const profileInputs = {
        'review-capabilities': { code: true, test: true },
        'paths': { runtime_roots: ['units/'], ordinary_doc_paths: ['CHANGELOG.md'] },
        'token-economy': { enabled: true },
        'skill-packs': { installed: ['core'] }
    };
    const formats = {
        compact: (value: unknown) => JSON.stringify(value),
        newline: (value: unknown) => JSON.stringify(value, null, 2) + '\n',
        crlf: (value: unknown) => JSON.stringify(value, null, 4).replace(/\n/g, '\r\n') + '\r\n'
    };
    for (const [name, config] of Object.entries(profileInputs)) {
        for (const [format, serialize] of Object.entries(formats)) {
            it(`preserves unchanged ${name} bytes in ${format} format across repeated updates`, () => {
                const original = serialize(config);
                withConfigStage(name, config, original, ({ file, run }) => {
                    run();
                    assert.equal(fs.readFileSync(file, 'utf8'), original);
                    run();
                    assert.equal(fs.readFileSync(file, 'utf8'), original);
                });
            });
        }
    }

    it('fills missing defaults while retaining existing project choices and then stays unchanged', () => {
        const template = { runtime_roots: ['src/'], ordinary_doc_paths: [], metrics_path: 'runtime/metrics.jsonl' };
        withConfigStage('paths', template, '{"runtime_roots":["units/"]}\n', ({ file, run }) => {
            run();
            assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { ...template, runtime_roots: ['units/'] });
            const merged = fs.readFileSync(file);
            run();
            assert.deepEqual(fs.readFileSync(file), merged);
        });
    });

    it('still writes newly installed configuration', () => {
        const template = { runtime_roots: ['units/'] };
        withConfigStage('paths', template, null, ({ file, run }) => {
            run();
            assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), template);
        });
    });

    it('retains canonical garda.config replacement even when its JSON values are already equal', () => {
        const template = { version: 1, configs: { paths: 'paths.json' } };
        withConfigStage('garda.config', template, JSON.stringify(template) + '\n', ({ file, run }) => {
            run();
            assert.equal(fs.readFileSync(file, 'utf8'), JSON.stringify(template, null, 2));
        });
    });

    it('preserves changed configuration during a dry run', () => {
        const original = '{"runtime_roots":["units/"]}\r\n';
        withConfigStage('paths', { runtime_roots: [], ordinary_doc_paths: [] }, original, ({ file, run }) => {
            run(true);
            assert.equal(fs.readFileSync(file, 'utf8'), original);
        });
    });

    it('rejects malformed existing JSON and preserves the original file', () => {
        const original = '{"runtime_roots":';
        withConfigStage('paths', { runtime_roots: [] }, original, ({ file, run }) => {
            assert.throws(() => run(), /cannot be read as a JSON object/);
            assert.equal(fs.readFileSync(file, 'utf8'), original);
        });
    });
});
