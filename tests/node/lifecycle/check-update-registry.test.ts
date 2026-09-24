import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import {
    cleanupOldUpdateTempRoots,
    getUpdateTempRoot,
    resolveNpmUpdateSourceSpec
} from '../../../src/lifecycle/check-update';
import { removePathRecursive } from '../../../src/lifecycle/common';

describe('npm update source resolution', () => {
    it('resolves floating registry specs to exact package specs with integrity', () => {
        const result = resolveNpmUpdateSourceSpec('garda-agent-orchestrator@latest', {
            viewRunner(args) {
                assert.deepEqual(args, [
                    'view',
                    'garda-agent-orchestrator@latest',
                    'version',
                    'dist.integrity',
                    '--json'
                ]);
                return {
                    status: 0,
                    stdout: JSON.stringify({
                        version: '2.3.4',
                        'dist.integrity': 'sha512-resolved'
                    })
                };
            }
        });

        assert.deepEqual(result, {
            requestedSpec: 'garda-agent-orchestrator@latest',
            exactSpec: 'garda-agent-orchestrator@2.3.4',
            packageName: 'garda-agent-orchestrator',
            version: '2.3.4',
            integrity: 'sha512-resolved',
            resolutionMode: 'resolved'
        });
    });

    it('keeps explicit exact package specs stable without latest resolution', () => {
        const result = resolveNpmUpdateSourceSpec('garda-agent-orchestrator@2.3.4', {
            viewRunner(args) {
                assert.deepEqual(args, [
                    'view',
                    'garda-agent-orchestrator@2.3.4',
                    'version',
                    'dist.integrity',
                    '--json'
                ]);
                return {
                    status: 0,
                    stdout: JSON.stringify({
                        version: '2.3.4',
                        'dist.integrity': 'sha512-exact'
                    })
                };
            }
        });

        assert.deepEqual(result, {
            requestedSpec: 'garda-agent-orchestrator@2.3.4',
            exactSpec: 'garda-agent-orchestrator@2.3.4',
            packageName: 'garda-agent-orchestrator',
            version: '2.3.4',
            integrity: 'sha512-exact',
            resolutionMode: 'explicit_exact'
        });
    });

    it('fails closed when registry resolution omits integrity', () => {
        assert.throws(
            () => resolveNpmUpdateSourceSpec('garda-agent-orchestrator@latest', {
                viewRunner() {
                    return {
                        status: 0,
                        stdout: JSON.stringify({ version: '2.3.4' })
                    };
                }
            }),
            /dist\.integrity/
        );
    });

    it('resolves range metadata arrays to the highest exact version with integrity', () => {
        const result = resolveNpmUpdateSourceSpec('garda-agent-orchestrator@^2.0.0', {
            viewRunner(args) {
                assert.deepEqual(args, [
                    'view',
                    'garda-agent-orchestrator@^2.0.0',
                    'version',
                    'dist.integrity',
                    '--json'
                ]);
                return {
                    status: 0,
                    stdout: JSON.stringify([
                        {
                            version: '2.0.1',
                            'dist.integrity': 'sha512-older'
                        },
                        {
                            version: '2.1.0',
                            'dist.integrity': 'sha512-newer'
                        }
                    ])
                };
            }
        });

        assert.deepEqual(result, {
            requestedSpec: 'garda-agent-orchestrator@^2.0.0',
            exactSpec: 'garda-agent-orchestrator@2.1.0',
            packageName: 'garda-agent-orchestrator',
            version: '2.1.0',
            integrity: 'sha512-newer',
            resolutionMode: 'resolved'
        });
    });

    it('fails closed when exact requested version differs from registry metadata', () => {
        assert.throws(
            () => resolveNpmUpdateSourceSpec('garda-agent-orchestrator@2.3.4', {
                viewRunner() {
                    return {
                        status: 0,
                        stdout: JSON.stringify({
                            version: '2.3.5',
                            'dist.integrity': 'sha512-other'
                        })
                    };
                }
            }),
            /did not match requested update package version/
        );
    });

    it('janitor preserves old roots without a creator-owned binding', () => {
        const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-update-temp-'));
        try {
            const updateTempRoot = getUpdateTempRoot(runtimeRoot);
            const oldNpmRoot = path.join(updateTempRoot, 'npm-old');
            const freshNpmRoot = path.join(updateTempRoot, 'npm-fresh');
            const foreignRoot = path.join(updateTempRoot, 'foreign-old');
            fs.mkdirSync(oldNpmRoot, { recursive: true });
            fs.mkdirSync(freshNpmRoot, { recursive: true });
            fs.mkdirSync(foreignRoot, { recursive: true });

            const now = Date.now();
            const oldDate = new Date(now - 10_000);
            fs.utimesSync(oldNpmRoot, oldDate, oldDate);
            fs.utimesSync(foreignRoot, oldDate, oldDate);

            const removed = cleanupOldUpdateTempRoots(runtimeRoot, 5_000, now);

            assert.deepEqual(removed, []);
            assert.equal(fs.existsSync(oldNpmRoot), true);
            assert.equal(fs.existsSync(freshNpmRoot), true);
            assert.equal(fs.existsSync(foreignRoot), true);
        } finally {
            removePathRecursive(runtimeRoot);
        }
    });
});
