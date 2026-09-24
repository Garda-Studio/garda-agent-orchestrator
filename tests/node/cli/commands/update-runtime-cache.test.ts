import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';

function makeCacheModule(resolvedPath: string, exportsValue: Record<string, unknown>): NodeJS.Module {
    return {
        id: resolvedPath,
        filename: resolvedPath,
        loaded: true,
        path: path.dirname(resolvedPath),
        exports: exportsValue,
        parent: null,
        children: [],
        paths: [],
        isPreloading: false
    } as unknown as NodeJS.Module;
}

function restoreCachedModule(resolvedPath: string, originalModule: NodeJS.Module | undefined): void {
    if (originalModule) {
        require.cache[resolvedPath] = originalModule;
    } else {
        delete require.cache[resolvedPath];
    }
}

describe('CLI runtime entry refresh', () => {    it('runCliMain reloads the runtime entrypoint from cache between calls in a long-lived process', async () => {
        const mainPath = require.resolve('../../../../src/cli/main');
        const runtimeMainPath = require.resolve('../../../../src/cli/runtime-main');

        const originalMainModule = require.cache[mainPath];
        const originalRuntimeMainModule = require.cache[runtimeMainPath];

        const calls: string[] = [];

        require.cache[runtimeMainPath] = makeCacheModule(runtimeMainPath, {
            async runCliRuntimeMain() {
                calls.push('v1');
            },
            async runCliRuntimeMainWithHandling() {
                calls.push('v1-handled');
            }
        });
        delete require.cache[mainPath];

        try {
            const reloadedMainModule = require('../../../../src/cli/main') as typeof import('../../../../src/cli/main');

            await reloadedMainModule.runCliMain(['status'], 'stub-package-root');

            require.cache[runtimeMainPath] = makeCacheModule(runtimeMainPath, {
                async runCliRuntimeMain() {
                    calls.push('v2');
                },
                async runCliRuntimeMainWithHandling() {
                    calls.push('v2-handled');
                }
            });

            await reloadedMainModule.runCliMain(['status'], 'stub-package-root');

            assert.deepEqual(calls, ['v1', 'v2']);
        } finally {
            if (originalMainModule) {
                require.cache[mainPath] = originalMainModule;
            } else {
                delete require.cache[mainPath];
            }
            if (originalRuntimeMainModule) {
                require.cache[runtimeMainPath] = originalRuntimeMainModule;
            } else {
                delete require.cache[runtimeMainPath];
            }
        }
    });

    it('runCliMainWithHandling reloads the handled runtime entrypoint from cache between calls in a long-lived process', async () => {
        const mainPath = require.resolve('../../../../src/cli/main');
        const runtimeMainPath = require.resolve('../../../../src/cli/runtime-main');

        const originalMainModule = require.cache[mainPath];
        const originalRuntimeMainModule = require.cache[runtimeMainPath];

        const calls: string[] = [];

        require.cache[runtimeMainPath] = makeCacheModule(runtimeMainPath, {
            async runCliRuntimeMain() {
                calls.push('v1');
            },
            async runCliRuntimeMainWithHandling() {
                calls.push('v1-handled');
            }
        });
        delete require.cache[mainPath];

        try {
            const reloadedMainModule = require('../../../../src/cli/main') as typeof import('../../../../src/cli/main');

            await reloadedMainModule.runCliMainWithHandling(['status'], 'stub-package-root');

            require.cache[runtimeMainPath] = makeCacheModule(runtimeMainPath, {
                async runCliRuntimeMain() {
                    calls.push('v2');
                },
                async runCliRuntimeMainWithHandling() {
                    calls.push('v2-handled');
                }
            });

            await reloadedMainModule.runCliMainWithHandling(['status'], 'stub-package-root');

            assert.deepEqual(calls, ['v1-handled', 'v2-handled']);
        } finally {
            restoreCachedModule(mainPath, originalMainModule);
            restoreCachedModule(runtimeMainPath, originalRuntimeMainModule);
        }
    });
});
