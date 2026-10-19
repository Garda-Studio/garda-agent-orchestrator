import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import {
    getProjectDiscovery,
    buildProjectDiscoveryLines,
    buildDiscoveryOverlaySection,
    resolveSuggestedCompileGateCommands,
    resolveSuggestedFullSuiteValidationCommand,
    STACK_SIGNALS,
    ProjectDiscovery
} from '../../../src/materialization/project-discovery';

describe('STACK_SIGNALS', () => {
    it('covers expected tech stacks', () => {
        const names = STACK_SIGNALS.map((s) => s.name);
        assert.ok(names.includes('Node.js or JavaScript'));
        assert.ok(names.includes('Python'));
        assert.ok(names.includes('Go'));
        assert.ok(names.includes('Rust'));
        assert.ok(names.includes('.NET'));
        assert.ok(names.includes('TypeScript'));
        assert.ok(names.includes('Java or JVM'));
    });
});

describe('getProjectDiscovery', () => {
    it('discovers stack signals from filesystem', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-discovery-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({
                scripts: { build: 'vite build' }
            }));
            fs.writeFileSync(path.join(tmpDir, 'go.mod'), 'module test');
            fs.mkdirSync(path.join(tmpDir, 'src'));
            fs.writeFileSync(path.join(tmpDir, 'src', 'main.go'), '');

            const result = getProjectDiscovery(tmpDir);
            assert.ok(result.source === 'filesystem_scan' || result.source === 'git_index_and_worktree');
            assert.ok(result.fileCount >= 2);
            assert.ok(result.detectedStacks.includes('Node.js or JavaScript'));
            assert.ok(result.detectedStacks.includes('Go'));
            assert.ok(result.suggestedCommands.length > 0);
            assert.ok(result.suggestedCompileGateCommands.includes('npm run build'));
            assert.ok(result.suggestedCompileGateCommands.includes('go build ./...'));
            assert.equal(result.suggestedFullSuiteValidationCommand, 'go test ./...');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('excludes garda-agent-orchestrator paths', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-discovery-excl-'));
        try {
            const gaoDir = path.join(tmpDir, 'garda-agent-orchestrator');
            fs.mkdirSync(gaoDir, { recursive: true });
            fs.writeFileSync(path.join(gaoDir, 'package.json'), '{}');
            fs.writeFileSync(path.join(tmpDir, 'README.md'), '# Hello');

            const result = getProjectDiscovery(tmpDir);
            assert.ok(!result.detectedStacks.includes('Node.js or JavaScript'));
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('detects Java or JVM projects from common root files', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-discovery-java-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'pom.xml'), '<project />');
            fs.writeFileSync(path.join(tmpDir, 'build.gradle.kts'), '');

            const result = getProjectDiscovery(tmpDir);
            assert.ok(result.detectedStacks.includes('Java or JVM'));
            assert.ok(result.stackEvidence.some((item) => item.name === 'Java or JVM'));
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('returns top-level directories excluding excluded ones', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-discovery-dirs-'));
        try {
            fs.mkdirSync(path.join(tmpDir, 'src'));
            fs.mkdirSync(path.join(tmpDir, '.git'));
            fs.mkdirSync(path.join(tmpDir, 'node_modules'));
            fs.mkdirSync(path.join(tmpDir, 'docs'));

            const result = getProjectDiscovery(tmpDir);
            assert.ok(result.topLevelDirectories.includes('src'));
            assert.ok(result.topLevelDirectories.includes('docs'));
            assert.ok(!result.topLevelDirectories.includes('.git'));
            assert.ok(!result.topLevelDirectories.includes('node_modules'));
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('skips excluded roots before fallback recursion budgets are consumed', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-discovery-budget-excl-'));
        try {
            fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
            fs.writeFileSync(path.join(tmpDir, 'src', 'main.ts'), '');
            fs.mkdirSync(path.join(tmpDir, 'node_modules', 'pkg', 'nested'), { recursive: true });
            fs.writeFileSync(path.join(tmpDir, 'node_modules', 'pkg', 'nested', 'package.json'), '{}');
            fs.mkdirSync(path.join(tmpDir, 'runtime', 'reviews'), { recursive: true });
            fs.writeFileSync(path.join(tmpDir, 'runtime', 'reviews', 'artifact.json'), '{}');

            const result = getProjectDiscovery(tmpDir, {
                fallbackScanMaxDirectories: 2,
                fallbackScanMaxFiles: 10,
                fallbackScanMaxElapsedMs: 1000
            });

            assert.ok(result.relativeFiles.includes('src/main.ts'));
            assert.ok(!result.relativeFiles.some((filePath) => filePath.startsWith('node_modules/')));
            assert.ok(!result.relativeFiles.some((filePath) => filePath.startsWith('runtime/')));
            assert.equal(result.diagnostics.length, 0);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('reports partial fallback diagnostics when filesystem scan budget is reached', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-discovery-budget-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'a.txt'), '');
            fs.writeFileSync(path.join(tmpDir, 'b.txt'), '');
            fs.writeFileSync(path.join(tmpDir, 'c.txt'), '');

            const result = getProjectDiscovery(tmpDir, {
                fallbackScanMaxFiles: 2,
                fallbackScanMaxDirectories: 10,
                fallbackScanMaxElapsedMs: 1000
            });

            assert.equal(result.fileCount, 2);
            assert.ok(result.diagnostics.some((message) => message.includes('Filesystem fallback scan stopped early: file budget reached (2)')));
            const lines = buildProjectDiscoveryLines(result, '2025-01-01T00:00:00Z').join('\n');
            assert.ok(lines.includes('## Discovery Diagnostics'));
            assert.ok(lines.includes('partial project discovery results were used'));
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

describe('resolveSuggestedFullSuiteValidationCommand', () => {
    it('prefers pnpm test when pnpm signals are present', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-discovery-pnpm-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({
                packageManager: 'pnpm@9.0.0',
                scripts: { test: 'vitest run' }
            }), 'utf8');
            fs.writeFileSync(path.join(tmpDir, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0');

            assert.equal(resolveSuggestedFullSuiteValidationCommand(tmpDir), 'pnpm test');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('prefers Maven wrapper when pom.xml and mvnw are present', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-discovery-mvnw-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'pom.xml'), '<project />', 'utf8');
            fs.writeFileSync(path.join(tmpDir, 'mvnw'), '#!/bin/sh\n', 'utf8');

            assert.equal(resolveSuggestedFullSuiteValidationCommand(tmpDir), './mvnw test');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('prefers Maven cmd wrapper on Windows when pom.xml and mvnw.cmd are present', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-discovery-mvnw-cmd-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'pom.xml'), '<project />', 'utf8');
            fs.writeFileSync(path.join(tmpDir, 'mvnw.cmd'), '@echo off\r\n', 'utf8');

            assert.equal(resolveSuggestedFullSuiteValidationCommand(tmpDir, 'win32'), '.\\mvnw.cmd test');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('prefers Gradle bat wrapper on Windows when gradle files and gradlew.bat are present', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-discovery-gradlew-bat-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'build.gradle.kts'), 'plugins {}\n', 'utf8');
            fs.writeFileSync(path.join(tmpDir, 'gradlew.bat'), '@echo off\r\n', 'utf8');

            assert.equal(resolveSuggestedFullSuiteValidationCommand(tmpDir, 'win32'), '.\\gradlew.bat test');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('does not fall back to npm test for unknown stacks', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-discovery-unknown-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'README.md'), '# Unknown\n', 'utf8');

            assert.equal(resolveSuggestedFullSuiteValidationCommand(tmpDir), null);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

describe('resolveSuggestedCompileGateCommands', () => {
    it('prefers package-manager build and typecheck scripts for Node workspaces', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-discovery-node-compile-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({
                packageManager: 'pnpm@9.0.0',
                scripts: { build: 'vite build', typecheck: 'tsc --noEmit', test: 'vitest run' }
            }), 'utf8');

            const result = resolveSuggestedCompileGateCommands(tmpDir);
            assert.ok(result.includes('pnpm run build'));
            assert.ok(result.includes('pnpm run typecheck'));
            assert.ok(!result.includes('pnpm test'));
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('does not invent npm build for Node workspaces without compile scripts', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-discovery-node-no-build-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({
                scripts: { test: 'vitest run' }
            }), 'utf8');

            const result = resolveSuggestedCompileGateCommands(tmpDir);
            assert.ok(!result.includes('npm run build'));
            assert.deepEqual(result, []);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('uses compile-only JVM suggestions instead of test tasks', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-discovery-jvm-compile-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'pom.xml'), '<project />', 'utf8');
            fs.writeFileSync(path.join(tmpDir, 'mvnw'), '#!/bin/sh\n', 'utf8');
            fs.writeFileSync(path.join(tmpDir, 'build.gradle.kts'), 'plugins {}\n', 'utf8');
            fs.writeFileSync(path.join(tmpDir, 'gradlew.bat'), '@echo off\r\n', 'utf8');

            const result = resolveSuggestedCompileGateCommands(tmpDir, 'win32');
            assert.ok(result.includes('./mvnw compile'));
            assert.ok(result.includes('.\\gradlew.bat assemble'));
            assert.ok(!result.some((command) => /\btest\b/.test(command)));
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('composes Maven backend and frontend build checks while ignoring heavyweight root build scripts', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-discovery-multistack-'));
        try {
            fs.mkdirSync(path.join(tmpDir, 'backend'), { recursive: true });
            fs.mkdirSync(path.join(tmpDir, 'frontend'), { recursive: true });
            fs.mkdirSync(path.join(tmpDir, 'scripts'), { recursive: true });
            fs.writeFileSync(path.join(tmpDir, 'backend', 'pom.xml'), '<project />', 'utf8');
            fs.writeFileSync(path.join(tmpDir, 'frontend', 'package.json'), JSON.stringify({
                scripts: { build: 'vite build', test: 'vitest run' }
            }), 'utf8');
            fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({
                scripts: { build: 'bash ./scripts/build.sh -f' }
            }), 'utf8');
            fs.writeFileSync(path.join(tmpDir, 'scripts', 'build.sh'), '#!/bin/sh\n', 'utf8');

            const result = resolveSuggestedCompileGateCommands(tmpDir, 'linux');

            assert.equal(result[0], 'npm --prefix frontend run build && mvn -f backend/pom.xml compile');
            assert.ok(result.includes('npm --prefix frontend run build'));
            assert.ok(result.includes('mvn -f backend/pom.xml compile'));
            assert.ok(!result.some((command) => command.includes('build.sh -f')));
            assert.ok(!result.some((command) => /\btest\b/.test(command)));
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('keeps compile-gate suggestions empty when only heavyweight scripts are available', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-discovery-heavy-build-'));
        try {
            fs.mkdirSync(path.join(tmpDir, 'scripts'), { recursive: true });
            fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({
                scripts: {
                    build: 'bash ./scripts/build.sh -f',
                    compile: 'docker build -t app .',
                    typecheck: 'npm run test'
                }
            }), 'utf8');
            fs.writeFileSync(path.join(tmpDir, 'scripts', 'build.sh'), '#!/bin/sh\n', 'utf8');

            assert.deepEqual(resolveSuggestedCompileGateCommands(tmpDir), []);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('keeps static sites without build metadata unconfigured', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-discovery-static-site-'));
        try {
            fs.mkdirSync(path.join(tmpDir, 'assets'), { recursive: true });
            fs.writeFileSync(path.join(tmpDir, 'index.html'), '<!doctype html>\n', 'utf8');
            fs.writeFileSync(path.join(tmpDir, 'assets', 'site.css'), 'body {}\n', 'utf8');

            assert.deepEqual(resolveSuggestedCompileGateCommands(tmpDir), []);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

describe('buildProjectDiscoveryLines', () => {
    it('produces markdown with expected sections', () => {
        const discovery = {
            source: 'filesystem_scan',
            fileCount: 5,
            detectedStacks: ['Node.js or JavaScript'],
            stackEvidence: [{ name: 'Node.js or JavaScript', matches: ['package.json'] }],
            topLevelDirectories: ['src', 'docs'],
            rootFiles: ['package.json', 'README.md'],
            runtimePathHints: ['src/'],
            suggestedCommands: ['npm run test'],
            suggestedCompileGateCommands: ['pnpm run build'],
            suggestedFullSuiteValidationCommand: 'pnpm test',
            sampleFiles: ['package.json', 'src/index.js']
        };
        const lines = buildProjectDiscoveryLines(discovery as unknown as ProjectDiscovery, '2025-01-01T00:00:00Z');
        const text = lines.join('\n');
        assert.ok(text.includes('# Project Discovery'));
        assert.ok(text.includes('## Detected Stack Signals'));
        assert.ok(text.includes('Node.js or JavaScript'));
        assert.ok(text.includes('## Top-Level Directories'));
        assert.ok(text.includes('## Stack Evidence'));
        assert.ok(text.includes('## Root Files'));
        assert.ok(text.includes('## Runtime Path Hints'));
        assert.ok(text.includes('## Suggested Compile Gate Commands'));
        assert.ok(text.includes('pnpm run build'));
        assert.ok(text.includes('## Suggested Local Commands'));
        assert.ok(text.includes('## Suggested Full-Suite Validation Command'));
        assert.ok(text.includes('pnpm test'));
        assert.ok(text.includes('## Sample Files Used'));
    });
});

describe('buildDiscoveryOverlaySection', () => {
    it('produces compact snapshot', () => {
        const discovery = {
            source: 'git_index_and_worktree',
            fileCount: 100,
            detectedStacks: ['Python', 'Go'],
            topLevelDirectories: ['src', 'cmd'],
            suggestedCompileGateCommands: ['go build ./...']
        };
        const result = buildDiscoveryOverlaySection(discovery as unknown as ProjectDiscovery);
        assert.ok(result.includes('## Project Discovery Snapshot'));
        assert.ok(result.includes('Python, Go'));
        assert.ok(result.includes('src, cmd'));
        assert.ok(result.includes('Suggested compile-gate command: `go build ./...`'));
    });

    it('shows none detected for empty stacks', () => {
        const discovery = {
            source: 'filesystem_scan',
            fileCount: 0,
            detectedStacks: [],
            topLevelDirectories: [],
            suggestedCompileGateCommands: []
        };
        const result = buildDiscoveryOverlaySection(discovery as unknown as ProjectDiscovery);
        assert.ok(result.includes('none detected'));
    });

    it('includes discovered full-suite command in the compact snapshot', () => {
        const discovery = {
            source: 'filesystem_scan',
            fileCount: 2,
            detectedStacks: ['Java or JVM'],
            topLevelDirectories: ['src'],
            suggestedCompileGateCommands: ['./gradlew assemble'],
            suggestedFullSuiteValidationCommand: './gradlew test'
        };
        const result = buildDiscoveryOverlaySection(discovery as unknown as ProjectDiscovery);
        assert.ok(result.includes('Suggested full-suite validation command: `./gradlew test`'));
    });

    it('keeps unknown stack full-suite guidance unconfigured in the compact snapshot', () => {
        const discovery = {
            source: 'filesystem_scan',
            fileCount: 1,
            detectedStacks: [],
            topLevelDirectories: [],
            suggestedFullSuiteValidationCommand: null
        };
        const result = buildDiscoveryOverlaySection(discovery as unknown as ProjectDiscovery);
        assert.ok(result.includes('the agent must inspect and configure all applicable project validation surfaces'));
        assert.ok(result.includes('Coverage: unverified'));
    });
});

describe('.NET solution formats', () => {
    it('suggests dotnet build and test for an slnx solution with nested projects', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-discovery-slnx-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'Billing.slnx'), '<Solution />\n');
            fs.mkdirSync(path.join(tmpDir, 'src', 'Billing'), { recursive: true });
            fs.writeFileSync(path.join(tmpDir, 'src', 'Billing', 'Billing.csproj'), '<Project Sdk="Microsoft.NET.Sdk" />\n');
            assert.deepEqual(resolveSuggestedCompileGateCommands(tmpDir), ['dotnet build']);
            assert.ok(getProjectDiscovery(tmpDir).detectedStacks.includes('.NET'));
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});
