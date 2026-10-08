import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { runInitConfigStage } from '../../../src/materialization/init/init-config-stage';
import { getProjectDiscovery } from '../../../src/materialization/project-discovery';
import { findRepoRoot, setupTestWorkspace } from './install-workspace-builder';

function createConfigStageWorkspace() {
    const { projectRoot, bundleRoot } = setupTestWorkspace(findRepoRoot());
    const options = {
        targetRoot: projectRoot,
        templateRoot: path.join(bundleRoot, 'template'),
        liveRoot: path.join(bundleRoot, 'live'),
        workflowConfigExistedBeforeRun: false,
        preserveLegacyWorkflowConfigOmission: false,
        discovery: getProjectDiscovery(projectRoot),
        preservedCompileGateCommand: null,
        tokenEconomyEnabled: true,
        dryRun: false
    };
    runInitConfigStage(options);
    return { projectRoot, options, configPath: path.join(options.liveRoot, 'config', 'workflow-config.json') };
}

describe('unchanged workflow-config materialization identity', () => {
    const formats: Record<string, (value: unknown) => string> = {
        compact: (value) => JSON.stringify(value),
        pretty: (value) => JSON.stringify(value, null, 4) + '\n',
        crlf: (value) => JSON.stringify(value, null, '\t').replace(/\n/g, '\r\n') + '\r\n',
        whitespace: (value) => '\n \t' + JSON.stringify(value) + ' \t\n',
        reordered: (value) => JSON.stringify(Object.fromEntries(Object.entries(value as object).reverse())),
        escaped: (value) => JSON.stringify(value).replace(/é/g, '\\u00e9')
    };

    for (const [format, serialize] of Object.entries(formats)) {
        it(`preserves the original ${format} bytes when merged values are unchanged`, () => {
            const { projectRoot, options, configPath } = createConfigStageWorkspace();
            try {
                const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
                config.custom_identity_fixture = { text: 'café', values: [1, 2] };
                const original = Buffer.from(serialize(config));
                fs.writeFileSync(configPath, original);

                const result = runInitConfigStage({ ...options, workflowConfigExistedBeforeRun: true });

                assert.deepEqual(result.materializedWorkflowConfig, config);
                assert.ok(fs.readFileSync(configPath).equals(original), `Original ${format} bytes must survive`);
            } finally {
                fs.rmSync(projectRoot, { recursive: true, force: true });
            }
        });
    }

    for (const original of ['{ "private_fixture": "retained-marker"', 'null', '[]']) {
        it(`rejects ${original} without replacing existing configuration bytes`, () => {
            const { projectRoot, options, configPath } = createConfigStageWorkspace();
            try {
                fs.writeFileSync(configPath, original);
                assert.throws(() => runInitConfigStage({ ...options, workflowConfigExistedBeforeRun: true }),
                    (error: unknown) => {
                        assert.ok(error instanceof Error);
                        assert.match(error.message, /existing.*config|config.*existing/i);
                        assert.equal(error.message.includes('retained-marker'), false);
                        return true;
                    });
                assert.equal(fs.readFileSync(configPath, 'utf8'), original);
            } finally {
                fs.rmSync(projectRoot, { recursive: true, force: true });
            }
        });
    }

    it('fills valid empty-object configuration with missing defaults', () => {
        const { projectRoot, options, configPath } = createConfigStageWorkspace();
        try {
            fs.writeFileSync(configPath, '{}');
            const result = runInitConfigStage({ ...options, workflowConfigExistedBeforeRun: true });
            assert.deepEqual(JSON.parse(fs.readFileSync(configPath, 'utf8')), result.materializedWorkflowConfig);
            assert.ok(Object.hasOwn(result.materializedWorkflowConfig, 'compile_gate'));
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });
});
