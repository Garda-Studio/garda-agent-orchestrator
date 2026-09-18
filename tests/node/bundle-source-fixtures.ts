import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { TestContext } from 'node:test';
import * as ts from 'typescript';

import { DEPLOY_ITEMS } from '../../src/cli/commands/cli-constants';
import { PRIMARY_CLI_ENTRYPOINT, resolveBundleName } from '../../src/core/constants';
import { buildRequiredPaths } from '../../src/validators/workspace-layout';

const SOURCE_CLI_ENTRYPOINT = 'src/bin/garda.ts';

function findSourceRoot(): string {
    let current = __dirname;
    while (current !== path.dirname(current)) {
        if (fs.existsSync(path.join(current, 'VERSION')) && fs.existsSync(path.join(current, 'template'))) {
            return current;
        }
        current = path.dirname(current);
    }
    throw new Error('Cannot find tracked bundle source root');
}

// These fixtures exercise layout and materialization in-process, not deployed CLI execution.
export function seedCompiledRuntimeLayout(bundleRoot: string): void {
    const fixtureName = resolveBundleName();
    const runtimePaths = buildRequiredPaths({})
        .filter((entry) => entry.startsWith(`${fixtureName}/dist/`));
    for (const entry of runtimePaths) {
        const runtimePath = path.join(bundleRoot, entry.slice(fixtureName.length + 1));
        if (entry.endsWith('.js')) {
            fs.mkdirSync(path.dirname(runtimePath), { recursive: true });
            fs.writeFileSync(runtimePath, 'module.exports = {};\n');
        } else {
            fs.mkdirSync(runtimePath, { recursive: true });
        }
    }
}

export function createBundleSourceFixture(context: TestContext, sourceRoot = findSourceRoot()): string {
    const bundleRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-bundle-source-fixture-'));
    context.after(() => fs.rmSync(bundleRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
    const trackedPaths = childProcess.execFileSync('git', ['ls-files', '-z', '--', ...DEPLOY_ITEMS, SOURCE_CLI_ENTRYPOINT], {
        cwd: sourceRoot, encoding: 'utf8', windowsHide: true, timeout: 30_000, maxBuffer: 4 * 1024 * 1024
    }).split('\0').filter(Boolean);
    for (const relativePath of trackedPaths) {
        const sourcePath = path.join(sourceRoot, relativePath);
        if (!fs.lstatSync(sourcePath).isFile()) {
            throw new Error(`Bundle fixture input must be a regular tracked file: ${relativePath}`);
        }
        const destinationPath = path.join(bundleRoot, relativePath === SOURCE_CLI_ENTRYPOINT ? PRIMARY_CLI_ENTRYPOINT : relativePath);
        fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
        if (relativePath === SOURCE_CLI_ENTRYPOINT) {
            const result = ts.transpileModule(fs.readFileSync(sourcePath, 'utf8'), {
                fileName: SOURCE_CLI_ENTRYPOINT,
                compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
            });
            fs.writeFileSync(destinationPath, result.outputText);
        } else {
            fs.copyFileSync(sourcePath, destinationPath);
        }
    }
    for (const entry of DEPLOY_ITEMS) {
        if (!fs.existsSync(path.join(bundleRoot, entry))) {
            throw new Error(`Tracked bundle fixture input is missing: ${entry}`);
        }
    }
    seedCompiledRuntimeLayout(bundleRoot);
    return bundleRoot;
}
