import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
    buildDiscoveryOverlaySection,
    buildProjectDiscoveryLines,
    getProjectDiscovery,
    resolveSuggestedFullSuiteValidationCommand
} from '../../../src/materialization/project-discovery';

function withProject(files: Record<string, string>, check: (root: string) => void): void {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-discovery-neutral-'));
    try {
        for (const [file, content] of Object.entries(files)) {
            fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
            fs.writeFileSync(path.join(root, file), content);
        }
        check(root);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
}

describe('discovery candidates do not assert validation coverage', () => {
    it('does not invent test or lint scripts for a package with only a build script', () => {
        withProject({ 'package.json': JSON.stringify({ scripts: { build: 'node build.cjs' } }) }, (root) => {
            const discovery = getProjectDiscovery(root);
            assert.equal(discovery.suggestedFullSuiteValidationCommand, null);
            assert.deepEqual(discovery.suggestedCommands, ['npm run build']);
        });
    });

    it('does not let the first recognized builder hide another validation surface', () => {
        withProject({
            'package.json': JSON.stringify({ scripts: { test: 'node check.cjs' } }),
            'go.mod': 'module example.invalid/project\n'
        }, (root) => {
            assert.equal(resolveSuggestedFullSuiteValidationCommand(root), null);
            const discovery = getProjectDiscovery(root);
            assert.ok(discovery.suggestedCommands.includes('npm test'));
            assert.ok(discovery.suggestedCommands.includes('go test ./...'));
        });
    });

    it('keeps unknown commands and layouts visible to ordinary agent setup', () => {
        withProject({
            'PROJECT.md': 'Validate with node tools/probe.cjs; source files are units/*.widget.\n',
            'tools/probe.cjs': 'process.exitCode = 0;\n',
            'units/main.widget': 'example\n'
        }, (root) => {
            const discovery = getProjectDiscovery(root);
            const report = buildProjectDiscoveryLines(discovery, '2026-10-18T00:00:00Z').join('\n');
            const overlay = buildDiscoveryOverlaySection(discovery);
            assert.equal(discovery.suggestedFullSuiteValidationCommand, null);
            assert.match(report, /coverage.*unverified/i);
            assert.match(report, /agent.*repository.*instructions/i);
            assert.match(overlay, /coverage.*unverified/i);
            assert.doesNotMatch(report + overlay, /fill context rules manually|populate .* manually|until an operator sets/i);
        });
    });
});
