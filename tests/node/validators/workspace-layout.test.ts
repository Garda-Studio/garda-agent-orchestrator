import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import {
    BASE_REQUIRED_PATHS,
    BUNDLE_RUNTIME_INVENTORY_PATHS,
    CRITICAL_BUNDLE_PATHS,
    RULE_FILES,
    OPTIONAL_RULE_SUPPORT_FILES,
    PROJECT_COMMAND_PLACEHOLDERS,
    MANAGED_START,
    MANAGED_END,
    buildRequiredPaths,
    detectMissingPaths,
    detectVersionViolations,
    detectGitignoreViolations,
    extractManagedBlock,
    getBundlePath,
    getCanonicalEntrypoint,
    getCommandsRulePath,
    getMissingProjectCommands,
    readUtf8IfExists,
    buildForcedSourceCheckoutRuntimeBuildCommand,
    detectSourceBundleParity,
    detectSourceCheckoutRuntimeStaleness,
    validateBundleInvariants,
    detectNestedBundleDuplication
} from '../../../src/validators/workspace-layout';

const EXPECTED_SOURCE_RUNTIME_REBUILD_COMMAND = buildForcedSourceCheckoutRuntimeBuildCommand();

test('detectSourceBundleParity returns isSourceCheckout false for empty dir', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-test-'));
    try {
        const result = detectSourceBundleParity(tmpDir);
        assert.equal(result.isSourceCheckout, false);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('detectSourceBundleParity detects stale bundle when version differs', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-test-'));
    try {
        fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
        fs.mkdirSync(path.join(tmpDir, 'bin'), { recursive: true });
        fs.mkdirSync(path.join(tmpDir, 'garda-agent-orchestrator', 'bin'), { recursive: true });
        fs.writeFileSync(path.join(tmpDir, 'package.json'), '{}', 'utf8');
        fs.writeFileSync(path.join(tmpDir, 'src', 'index.ts'), '', 'utf8');
        fs.writeFileSync(path.join(tmpDir, 'bin', 'garda.js'), '', 'utf8');
        fs.writeFileSync(path.join(tmpDir, 'garda-agent-orchestrator', 'bin', 'garda.js'), '', 'utf8');
        fs.writeFileSync(path.join(tmpDir, 'VERSION'), '1.0.1', 'utf8');
        fs.writeFileSync(path.join(tmpDir, 'garda-agent-orchestrator', 'VERSION'), '1.0.0', 'utf8');

        const result = detectSourceBundleParity(tmpDir);
        assert.equal(result.isSourceCheckout, true);
        assert.equal(result.isStale, true);
        assert.ok(result.violations.some(v => v.includes('version')));
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('detectSourceBundleParity detects stale bundle when launcher is older', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-test-'));
    try {
        fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
        fs.mkdirSync(path.join(tmpDir, 'bin'), { recursive: true });
        fs.mkdirSync(path.join(tmpDir, 'garda-agent-orchestrator', 'bin'), { recursive: true });
        fs.writeFileSync(path.join(tmpDir, 'package.json'), '{}', 'utf8');
        fs.writeFileSync(path.join(tmpDir, 'src', 'index.ts'), '', 'utf8');
        fs.writeFileSync(path.join(tmpDir, 'VERSION'), '1.0.0', 'utf8');
        fs.writeFileSync(path.join(tmpDir, 'garda-agent-orchestrator', 'VERSION'), '1.0.0', 'utf8');

        const rootLauncher = path.join(tmpDir, 'bin', 'garda.js');
        const bundleLauncher = path.join(tmpDir, 'garda-agent-orchestrator', 'bin', 'garda.js');

        fs.writeFileSync(bundleLauncher, 'old', 'utf8');
        // Ensure bundle is older by at least 2 seconds
        const bundleTime = new Date(Date.now() - 5000);
        fs.utimesSync(bundleLauncher, bundleTime, bundleTime);

        fs.writeFileSync(rootLauncher, 'new', 'utf8');

        const result = detectSourceBundleParity(tmpDir);
        assert.equal(result.isSourceCheckout, true);
        assert.equal(result.isStale, true);
        assert.ok(result.violations.some(v => v.includes('older than')));
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('detectSourceCheckoutRuntimeStaleness detects gate source newer than generated runtime', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-staleness-test-'));
    try {
        fs.mkdirSync(path.join(tmpDir, 'src', 'gates'), { recursive: true });
        fs.mkdirSync(path.join(tmpDir, 'bin'), { recursive: true });
        fs.mkdirSync(path.join(tmpDir, 'dist', 'src', 'gates'), { recursive: true });
        fs.writeFileSync(path.join(tmpDir, 'package.json'), '{}', 'utf8');
        fs.writeFileSync(path.join(tmpDir, 'src', 'index.ts'), 'export {};\n', 'utf8');
        fs.writeFileSync(path.join(tmpDir, 'bin', 'garda.js'), '#!/usr/bin/env node\n', 'utf8');
        fs.writeFileSync(path.join(tmpDir, 'dist', 'src', 'index.js'), 'module.exports = {};\n', 'utf8');
        const sourcePath = path.join(tmpDir, 'src', 'gates', 'next-step.ts');
        const generatedPath = path.join(tmpDir, 'dist', 'src', 'gates', 'next-step.js');
        fs.writeFileSync(sourcePath, 'export const source = true;\n', 'utf8');
        fs.writeFileSync(generatedPath, 'exports.source = false;\n', 'utf8');
        const oldTime = new Date(Date.now() - 5000);
        fs.utimesSync(generatedPath, oldTime, oldTime);
        fs.utimesSync(path.join(tmpDir, 'dist', 'src', 'index.js'), oldTime, oldTime);

        const result = detectSourceCheckoutRuntimeStaleness(tmpDir);

        assert.equal(result.isSourceCheckout, true);
        assert.equal(result.isStale, true);
        assert.ok(result.violations.some((violation) => violation.includes('src/gates/next-step.ts newer than dist/src/gates/next-step.js')));
        assert.ok(result.remediation?.includes('npm run build'));
        assert.ok(result.remediation?.includes(EXPECTED_SOURCE_RUNTIME_REBUILD_COMMAND));
        assert.ok(result.remediation?.includes('GARDA_BUILD_SCRIPTS_FORCE_REBUILD'));
        assert.ok(result.remediation?.includes('GARDA_PUBLISH_RUNTIME_FORCE_REBUILD'));
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('detectSourceCheckoutRuntimeStaleness detects missing generated runtime output', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-staleness-test-'));
    try {
        fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
        fs.mkdirSync(path.join(tmpDir, 'bin'), { recursive: true });
        fs.writeFileSync(path.join(tmpDir, 'package.json'), '{}', 'utf8');
        fs.writeFileSync(path.join(tmpDir, 'src', 'index.ts'), 'export {};\n', 'utf8');
        fs.writeFileSync(path.join(tmpDir, 'bin', 'garda.js'), '#!/usr/bin/env node\n', 'utf8');

        const result = detectSourceCheckoutRuntimeStaleness(tmpDir);

        assert.equal(result.isSourceCheckout, true);
        assert.equal(result.runtimeRoot, null);
        assert.equal(result.isStale, true);
        assert.ok(result.violations.some((violation) => violation.includes('Generated source-checkout runtime output is missing')));
        assert.ok(result.remediation?.includes('npm run build'));
        assert.ok(result.remediation?.includes(EXPECTED_SOURCE_RUNTIME_REBUILD_COMMAND));
        assert.ok(result.remediation?.includes('GARDA_BUILD_SCRIPTS_FORCE_REBUILD'));
        assert.ok(result.remediation?.includes('GARDA_PUBLISH_RUNTIME_FORCE_REBUILD'));
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('detectSourceCheckoutRuntimeStaleness detects missing generated file under existing runtime root', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-staleness-test-'));
    try {
        fs.mkdirSync(path.join(tmpDir, 'src', 'gates'), { recursive: true });
        fs.mkdirSync(path.join(tmpDir, 'bin'), { recursive: true });
        fs.mkdirSync(path.join(tmpDir, 'dist', 'src'), { recursive: true });
        fs.writeFileSync(path.join(tmpDir, 'package.json'), '{}', 'utf8');
        fs.writeFileSync(path.join(tmpDir, 'src', 'index.ts'), 'export {};\n', 'utf8');
        fs.writeFileSync(path.join(tmpDir, 'src', 'gates', 'next-step.ts'), 'export const source = true;\n', 'utf8');
        fs.writeFileSync(path.join(tmpDir, 'bin', 'garda.js'), '#!/usr/bin/env node\n', 'utf8');
        fs.writeFileSync(path.join(tmpDir, 'dist', 'src', 'index.js'), 'module.exports = {};\n', 'utf8');

        const result = detectSourceCheckoutRuntimeStaleness(tmpDir);

        assert.equal(result.isSourceCheckout, true);
        assert.equal(result.isStale, true);
        assert.ok(result.violations.some((violation) => violation.includes('src/gates/next-step.ts -> dist/src/gates/next-step.js')));
        assert.ok(result.remediation?.includes('npm run build'));
        assert.ok(result.remediation?.includes(EXPECTED_SOURCE_RUNTIME_REBUILD_COMMAND));
        assert.ok(result.remediation?.includes('GARDA_BUILD_SCRIPTS_FORCE_REBUILD'));
        assert.ok(result.remediation?.includes('GARDA_PUBLISH_RUNTIME_FORCE_REBUILD'));
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('detectSourceCheckoutRuntimeStaleness passes when generated runtime is current', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-staleness-test-'));
    try {
        fs.mkdirSync(path.join(tmpDir, 'src', 'gates'), { recursive: true });
        fs.mkdirSync(path.join(tmpDir, 'bin'), { recursive: true });
        fs.mkdirSync(path.join(tmpDir, 'dist', 'src', 'gates'), { recursive: true });
        fs.writeFileSync(path.join(tmpDir, 'package.json'), '{}', 'utf8');
        fs.writeFileSync(path.join(tmpDir, 'src', 'index.ts'), 'export {};\n', 'utf8');
        fs.writeFileSync(path.join(tmpDir, 'bin', 'garda.js'), '#!/usr/bin/env node\n', 'utf8');
        fs.writeFileSync(path.join(tmpDir, 'dist', 'src', 'index.js'), 'module.exports = {};\n', 'utf8');
        const sourcePath = path.join(tmpDir, 'src', 'gates', 'next-step.ts');
        const generatedPath = path.join(tmpDir, 'dist', 'src', 'gates', 'next-step.js');
        fs.writeFileSync(sourcePath, 'export const source = true;\n', 'utf8');
        fs.writeFileSync(generatedPath, 'exports.source = true;\n', 'utf8');
        const now = new Date();
        fs.utimesSync(sourcePath, now, now);
        fs.utimesSync(generatedPath, now, now);
        fs.utimesSync(path.join(tmpDir, 'dist', 'src', 'index.js'), now, now);

        const result = detectSourceCheckoutRuntimeStaleness(tmpDir);

        assert.equal(result.isSourceCheckout, true);
        assert.equal(result.isStale, false);
        assert.deepEqual(result.violations, []);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('detectSourceBundleParity passes when matching', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-test-'));
    try {
        fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
        fs.mkdirSync(path.join(tmpDir, 'bin'), { recursive: true });
        fs.mkdirSync(path.join(tmpDir, 'garda-agent-orchestrator', 'bin'), { recursive: true });
        fs.mkdirSync(path.join(tmpDir, 'garda-agent-orchestrator', 'dist', 'src'), { recursive: true });
        fs.mkdirSync(path.join(tmpDir, 'garda-agent-orchestrator', 'template'), { recursive: true });
        fs.mkdirSync(path.join(tmpDir, 'garda-agent-orchestrator', 'template', 'config'), { recursive: true });
        fs.mkdirSync(path.join(tmpDir, 'garda-agent-orchestrator', 'template', 'entrypoints'), { recursive: true });
        fs.mkdirSync(path.join(tmpDir, 'garda-agent-orchestrator', 'runtime'), { recursive: true });
        fs.mkdirSync(path.join(tmpDir, 'garda-agent-orchestrator', 'live', 'config'), { recursive: true });
        fs.writeFileSync(path.join(tmpDir, 'package.json'), '{}', 'utf8');
        fs.writeFileSync(path.join(tmpDir, 'src', 'index.ts'), '', 'utf8');
        fs.writeFileSync(path.join(tmpDir, 'VERSION'), '1.0.0', 'utf8');
        fs.writeFileSync(path.join(tmpDir, 'garda-agent-orchestrator', 'VERSION'), '1.0.0', 'utf8');
        fs.writeFileSync(path.join(tmpDir, 'garda-agent-orchestrator', 'package.json'), '{}', 'utf8');
        fs.writeFileSync(path.join(tmpDir, 'garda-agent-orchestrator', 'dist', 'src', 'index.js'), 'module.exports = {};', 'utf8');
        fs.writeFileSync(path.join(tmpDir, 'garda-agent-orchestrator', 'template', 'AGENTS.md'), '# template', 'utf8');
        fs.writeFileSync(path.join(tmpDir, 'garda-agent-orchestrator', 'template', 'entrypoints', 'canonical-rule-index.md'), '# template', 'utf8');
        fs.writeFileSync(path.join(tmpDir, 'garda-agent-orchestrator', 'template', 'config', 'garda.config.json'), '{}', 'utf8');
        fs.writeFileSync(path.join(tmpDir, 'garda-agent-orchestrator', 'runtime', 'init-answers.json'), '{}', 'utf8');
        fs.writeFileSync(path.join(tmpDir, 'garda-agent-orchestrator', 'live', 'config', 'review-capabilities.json'), '{}', 'utf8');
        fs.writeFileSync(path.join(tmpDir, 'garda-agent-orchestrator', 'live', 'config', 'paths.json'), '{}', 'utf8');
        fs.writeFileSync(path.join(tmpDir, 'garda-agent-orchestrator', 'live', 'config', 'token-economy.json'), '{}', 'utf8');
        fs.writeFileSync(path.join(tmpDir, 'garda-agent-orchestrator', 'live', 'config', 'output-filters.json'), '{}', 'utf8');
        fs.writeFileSync(path.join(tmpDir, 'garda-agent-orchestrator', 'live', 'config', 'skill-packs.json'), '{}', 'utf8');
        fs.writeFileSync(path.join(tmpDir, 'garda-agent-orchestrator', 'live', 'config', 'optional-skill-selection-policy.json'), '{}', 'utf8');
        fs.writeFileSync(path.join(tmpDir, 'garda-agent-orchestrator', 'live', 'config', 'isolation-mode.json'), '{}', 'utf8');
        fs.writeFileSync(path.join(tmpDir, 'garda-agent-orchestrator', 'live', 'config', 'profiles.json'), '{}', 'utf8');
        fs.writeFileSync(path.join(tmpDir, 'garda-agent-orchestrator', 'live', 'config', 'runtime-retention.json'), '{}', 'utf8');
        fs.writeFileSync(path.join(tmpDir, 'garda-agent-orchestrator', 'live', 'config', 'skills-index.json'), '{}', 'utf8');
        fs.writeFileSync(path.join(tmpDir, 'garda-agent-orchestrator', 'live', 'config', 'skills-headlines.json'), '{}', 'utf8');
        fs.writeFileSync(path.join(tmpDir, 'garda-agent-orchestrator', 'live', 'config', 'garda.config.json'), '{}', 'utf8');

        const rootLaunchers = [
            path.join(tmpDir, 'bin', 'garda.js'),
            path.join(tmpDir, 'bin', 'garda.js')
        ];
        const bundleLaunchers = [
            path.join(tmpDir, 'garda-agent-orchestrator', 'bin', 'garda.js'),
            path.join(tmpDir, 'garda-agent-orchestrator', 'bin', 'garda.js')
        ];

        for (const launcherPath of [...rootLaunchers, ...bundleLaunchers]) {
            fs.writeFileSync(launcherPath, 'same', 'utf8');
        }

        // Ensure same time
        const now = new Date();
        for (const launcherPath of [...rootLaunchers, ...bundleLaunchers]) {
            fs.utimesSync(launcherPath, now, now);
        }

        const result = detectSourceBundleParity(tmpDir);
        assert.equal(result.isSourceCheckout, true);
        assert.equal(result.isStale, false);
        assert.equal(result.violations.length, 0);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('validateBundleInvariants fails on partial runtime inventory', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-invariants-test-'));
    const bundlePath = path.join(tmpDir, 'garda-agent-orchestrator');
    try {
        for (const relPath of [...CRITICAL_BUNDLE_PATHS, ...BUNDLE_RUNTIME_INVENTORY_PATHS]) {
            const fullPath = path.join(bundlePath, relPath);
            fs.mkdirSync(path.dirname(fullPath), { recursive: true });
            fs.writeFileSync(fullPath, '{}', 'utf8');
        }

        fs.rmSync(path.join(bundlePath, 'live', 'config', 'paths.json'));

        const result = validateBundleInvariants(bundlePath);
        assert.equal(result.isValid, false);
        assert.ok(result.violations.some(v => v.includes('live/config/paths.json')));
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('validateBundleInvariants fails when isolation-mode inventory entry is missing', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-invariants-test-'));
    const bundlePath = path.join(tmpDir, 'garda-agent-orchestrator');
    try {
        for (const relPath of [...CRITICAL_BUNDLE_PATHS, ...BUNDLE_RUNTIME_INVENTORY_PATHS]) {
            const fullPath = path.join(bundlePath, relPath);
            fs.mkdirSync(path.dirname(fullPath), { recursive: true });
            fs.writeFileSync(fullPath, '{}', 'utf8');
        }

        fs.rmSync(path.join(bundlePath, 'live', 'config', 'isolation-mode.json'));

        const result = validateBundleInvariants(bundlePath);
        assert.equal(result.isValid, false);
        assert.ok(result.violations.some(v => v.includes('live/config/isolation-mode.json')));
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('validateBundleInvariants fails when runtime-retention inventory entry is missing', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-invariants-test-'));
    const bundlePath = path.join(tmpDir, 'garda-agent-orchestrator');
    try {
        for (const relPath of [...CRITICAL_BUNDLE_PATHS, ...BUNDLE_RUNTIME_INVENTORY_PATHS]) {
            const fullPath = path.join(bundlePath, relPath);
            fs.mkdirSync(path.dirname(fullPath), { recursive: true });
            fs.writeFileSync(fullPath, '{}', 'utf8');
        }

        fs.rmSync(path.join(bundlePath, 'live', 'config', 'runtime-retention.json'));

        const result = validateBundleInvariants(bundlePath);
        assert.equal(result.isValid, false);
        assert.ok(result.violations.some(v => v.includes('live/config/runtime-retention.json')));
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('validateBundleInvariants fails when skills-headlines inventory entry is missing', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-invariants-test-'));
    const bundlePath = path.join(tmpDir, 'garda-agent-orchestrator');
    try {
        for (const relPath of [...CRITICAL_BUNDLE_PATHS, ...BUNDLE_RUNTIME_INVENTORY_PATHS]) {
            const fullPath = path.join(bundlePath, relPath);
            fs.mkdirSync(path.dirname(fullPath), { recursive: true });
            fs.writeFileSync(fullPath, '{}', 'utf8');
        }

        fs.rmSync(path.join(bundlePath, 'live', 'config', 'skills-headlines.json'));

        const result = validateBundleInvariants(bundlePath);
        assert.equal(result.isValid, false);
        assert.ok(result.violations.some(v => v.includes('live/config/skills-headlines.json')));
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('validateBundleInvariants tolerates a missing optional-skill-selection-policy runtime config', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-invariants-test-'));
    const bundlePath = path.join(tmpDir, 'garda-agent-orchestrator');
    try {
        for (const relPath of [...CRITICAL_BUNDLE_PATHS, ...BUNDLE_RUNTIME_INVENTORY_PATHS]) {
            const fullPath = path.join(bundlePath, relPath);
            fs.mkdirSync(path.dirname(fullPath), { recursive: true });
            fs.writeFileSync(fullPath, '{}', 'utf8');
        }

        const result = validateBundleInvariants(bundlePath);
        assert.equal(result.isValid, true);
        assert.ok(!result.violations.some((v) => v.includes('optional-skill-selection-policy.json')));
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('validateBundleInvariants rejects deployed bundle .node-build runtime output', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-invariants-forbidden-node-build-test-'));
    const bundlePath = path.join(tmpDir, 'garda-agent-orchestrator');
    try {
        for (const relPath of [...CRITICAL_BUNDLE_PATHS, ...BUNDLE_RUNTIME_INVENTORY_PATHS]) {
            const fullPath = path.join(bundlePath, relPath);
            fs.mkdirSync(path.dirname(fullPath), { recursive: true });
            fs.writeFileSync(fullPath, '{}', 'utf8');
        }

        fs.mkdirSync(path.join(bundlePath, '.node-build', 'src'), { recursive: true });
        fs.writeFileSync(path.join(bundlePath, '.node-build', 'src', 'index.js'), 'module.exports = {};\n', 'utf8');

        const result = validateBundleInvariants(bundlePath);
        assert.equal(result.isValid, false);
        assert.ok(result.violations.some(v => v.includes("Forbidden deployed bundle path '.node-build'")));
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('validateBundleInvariants fails when garda.config runtime inventory entry is missing', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-invariants-test-'));
    const bundlePath = path.join(tmpDir, 'garda-agent-orchestrator');
    try {
        for (const relPath of [...CRITICAL_BUNDLE_PATHS, ...BUNDLE_RUNTIME_INVENTORY_PATHS]) {
            const fullPath = path.join(bundlePath, relPath);
            fs.mkdirSync(path.dirname(fullPath), { recursive: true });
            fs.writeFileSync(fullPath, '{}', 'utf8');
        }

        fs.rmSync(path.join(bundlePath, 'live', 'config', 'garda.config.json'));

        const result = validateBundleInvariants(bundlePath);
        assert.equal(result.isValid, false);
        assert.ok(result.violations.some(v => v.includes('live/config/garda.config.json')));
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('validateBundleInvariants fails when template garda.config bundle file is missing', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-invariants-test-'));
    const bundlePath = path.join(tmpDir, 'garda-agent-orchestrator');
    try {
        for (const relPath of [...CRITICAL_BUNDLE_PATHS, ...BUNDLE_RUNTIME_INVENTORY_PATHS]) {
            const fullPath = path.join(bundlePath, relPath);
            fs.mkdirSync(path.dirname(fullPath), { recursive: true });
            fs.writeFileSync(fullPath, '{}', 'utf8');
        }

        fs.rmSync(path.join(bundlePath, 'template', 'config', 'garda.config.json'));

        const result = validateBundleInvariants(bundlePath);
        assert.equal(result.isValid, false);
        assert.ok(result.violations.some(v => v.includes('template/config/garda.config.json')));
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('BASE_REQUIRED_PATHS is a frozen non-empty array', () => {
    assert.ok(Array.isArray(BASE_REQUIRED_PATHS));
    assert.ok(BASE_REQUIRED_PATHS.length > 25);
    assert.ok(Object.isFrozen(BASE_REQUIRED_PATHS));
    assert.ok(BASE_REQUIRED_PATHS.includes('garda-agent-orchestrator/dist/src/index.js'));
    assert.ok(!BASE_REQUIRED_PATHS.some(requiredPath => /^garda-agent-orchestrator\/src(?:\/|$)/.test(requiredPath)));
    assert.ok(BASE_REQUIRED_PATHS.includes('garda-agent-orchestrator/live/config/skills-index.json'));
    assert.ok(BASE_REQUIRED_PATHS.includes('garda-agent-orchestrator/live/config/skills-headlines.json'));
    assert.ok(!BASE_REQUIRED_PATHS.includes('garda-agent-orchestrator/live/config/optional-skill-selection-policy.json'));
    assert.ok(BASE_REQUIRED_PATHS.includes('garda-agent-orchestrator/live/config/isolation-mode.json'));
    assert.ok(BUNDLE_RUNTIME_INVENTORY_PATHS.includes('live/config/runtime-retention.json'));
    assert.ok(BASE_REQUIRED_PATHS.includes('garda-agent-orchestrator/live/config/garda.config.json'));
    assert.ok(BASE_REQUIRED_PATHS.includes('garda-agent-orchestrator/template/config/garda.config.json'));
    assert.ok(BASE_REQUIRED_PATHS.includes('garda-agent-orchestrator/live/skills/orchestration/skill.json'));
    assert.ok(BASE_REQUIRED_PATHS.includes('garda-agent-orchestrator/live/skills/dependency-review/skill.json'));
    assert.ok(!BASE_REQUIRED_PATHS.includes('.qwen/settings.json'));
});

test('compiled-only deployment requires runtime files, not TypeScript sources', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compiled-layout-'));
    const runtimePaths = [
        'garda-agent-orchestrator/dist/src',
        'garda-agent-orchestrator/dist/src/index.js',
        ...['cli', 'gates', 'lifecycle', 'materialization', 'validators']
            .map(directory => `garda-agent-orchestrator/dist/src/${directory}`)
    ];
    try {
        const requiredPaths = buildRequiredPaths({});
        for (const runtimePath of runtimePaths) {
            assert.ok(requiredPaths.includes(runtimePath), `Required compiled runtime: ${runtimePath}`);
            const absolutePath = path.join(tmpDir, runtimePath);
            if (runtimePath.endsWith('.js')) {
                fs.writeFileSync(absolutePath, 'module.exports = {};\n', 'utf8');
            } else {
                fs.mkdirSync(absolutePath, { recursive: true });
            }
        }
        assert.equal(fs.existsSync(path.join(tmpDir, 'garda-agent-orchestrator', 'src')), false);
        assert.deepEqual(detectMissingPaths(tmpDir, runtimePaths), []);
        fs.unlinkSync(path.join(tmpDir, runtimePaths[1]));
        assert.deepEqual(detectMissingPaths(tmpDir, runtimePaths), [runtimePaths[1]]);
        fs.rmdirSync(path.join(tmpDir, runtimePaths[6]));
        assert.deepEqual(detectMissingPaths(tmpDir, runtimePaths), [runtimePaths[1], runtimePaths[6]]);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('RULE_FILES contains all 12 standard rule files', () => {
    assert.equal(RULE_FILES.length, 12);
    assert.ok(RULE_FILES.includes('00-core.md'));
    assert.ok(RULE_FILES.includes('15-project-memory.md'));
    assert.ok(RULE_FILES.includes('40-commands.md'));
    assert.ok(RULE_FILES.includes('90-skill-catalog.md'));
    assert.ok(!RULE_FILES.includes('40-command-reference.md'));
});

test('OPTIONAL_RULE_SUPPORT_FILES contains command reference appendix outside standard rule files', () => {
    assert.deepEqual(OPTIONAL_RULE_SUPPORT_FILES, ['40-command-reference.md']);
    assert.ok(!RULE_FILES.includes(OPTIONAL_RULE_SUPPORT_FILES[0]));
});

test('PROJECT_COMMAND_PLACEHOLDERS contains expected placeholders', () => {
    assert.ok(PROJECT_COMMAND_PLACEHOLDERS.length >= 14);
    assert.ok(PROJECT_COMMAND_PLACEHOLDERS.includes('<install dependencies command>'));
    assert.ok(PROJECT_COMMAND_PLACEHOLDERS.includes('<unit test command>'));
});

test('getCanonicalEntrypoint maps known source-of-truth values', () => {
    assert.equal(getCanonicalEntrypoint('Claude'), 'CLAUDE.md');
    assert.equal(getCanonicalEntrypoint('Codex'), 'AGENTS.md');
    assert.equal(getCanonicalEntrypoint('Qwen'), 'QWEN.md');
    assert.equal(getCanonicalEntrypoint('GitHubCopilot'), '.github/copilot-instructions.md');
    assert.equal(getCanonicalEntrypoint('Windsurf'), '.windsurf/rules/rules.md');
    assert.equal(getCanonicalEntrypoint('Junie'), '.junie/guidelines.md');
    assert.equal(getCanonicalEntrypoint('Antigravity'), '.antigravity/rules.md');
    assert.equal(getCanonicalEntrypoint('Gemini'), 'GEMINI.md');
});

test('getCanonicalEntrypoint returns null for unknown values', () => {
    assert.equal(getCanonicalEntrypoint('Unknown'), null);
    assert.equal(getCanonicalEntrypoint(''), null);
});

test('getCanonicalEntrypoint is case-insensitive', () => {
    assert.equal(getCanonicalEntrypoint('claude'), 'CLAUDE.md');
    assert.equal(getCanonicalEntrypoint('CLAUDE'), 'CLAUDE.md');
    assert.equal(getCanonicalEntrypoint('qwen'), 'QWEN.md');
    assert.equal(getCanonicalEntrypoint('githubcopilot'), '.github/copilot-instructions.md');
    assert.equal(getCanonicalEntrypoint('GitHub Copilot CLI'), '.github/copilot-instructions.md');
    assert.equal(getCanonicalEntrypoint('github-copilot-coding-agent'), '.github/copilot-instructions.md');
});

test('getBundlePath joins target root with default bundle name', () => {
    const result = getBundlePath('/projects/my-app');
    assert.ok(result.includes('garda-agent-orchestrator'));
});

test('getBundlePath falls back to a valid legacy deployed bundle when the primary bundle is incomplete', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-path-test-'));
    try {
        fs.mkdirSync(path.join(tmpDir, 'garda-agent-orchestrator', 'runtime'), { recursive: true });

        const legacyBundle = path.join(tmpDir, 'garda-agent-orchestrator');
        fs.mkdirSync(path.join(legacyBundle, 'bin'), { recursive: true });
        fs.writeFileSync(path.join(legacyBundle, 'VERSION'), '1.0.0', 'utf8');
        fs.writeFileSync(path.join(legacyBundle, 'package.json'), '{"name":"garda-agent-orchestrator"}', 'utf8');
        fs.writeFileSync(path.join(legacyBundle, 'bin', 'garda.js'), '', 'utf8');

        const result = getBundlePath(tmpDir);
        assert.equal(result, legacyBundle);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('buildRequiredPaths includes base paths plus rule files', () => {
    const paths = buildRequiredPaths({});
    assert.ok(paths.length >= BASE_REQUIRED_PATHS.length);
    assert.ok(paths.includes('TASK.md'));
    assert.ok(paths.includes('garda-agent-orchestrator/VERSION'));
    assert.ok(paths.includes('garda-agent-orchestrator/live/config/garda.config.json'));
    assert.ok(paths.some(p => p.includes('00-core.md')));
    assert.ok(paths.some(p => p.includes('90-skill-catalog.md')));
    for (const rf of RULE_FILES) {
        assert.ok(
            paths.some(p => p.includes(rf)),
            `Expected required paths to include rule file ${rf}`
        );
    }
    for (const supportFile of OPTIONAL_RULE_SUPPORT_FILES) {
        assert.ok(
            paths.some(p => p.includes(supportFile)),
            `Expected required paths to include optional support file ${supportFile}`
        );
    }
});

test('buildRequiredPaths adds claude settings when claudeOrchestratorFullAccess', () => {
    const withAccess = buildRequiredPaths({ claudeOrchestratorFullAccess: true });
    const withoutAccess = buildRequiredPaths({ claudeOrchestratorFullAccess: false });
    assert.ok(withAccess.includes('.claude/settings.local.json'));
    assert.ok(!withoutAccess.includes('.claude/settings.local.json'));
});

test('buildRequiredPaths adds active agent files', () => {
    const paths = buildRequiredPaths({
        activeAgentFiles: ['CLAUDE.md', 'AGENTS.md']
    });
    assert.ok(paths.includes('CLAUDE.md'));
    assert.ok(paths.includes('AGENTS.md'));
});

test('detectMissingPaths finds missing paths in temp dir', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'layout-test-'));
    try {
        const missing = detectMissingPaths(tmpDir, ['existing.txt', 'missing.txt']);
        assert.deepEqual(missing, ['existing.txt', 'missing.txt']);

        fs.writeFileSync(path.join(tmpDir, 'existing.txt'), 'ok', 'utf8');
        const missing2 = detectMissingPaths(tmpDir, ['existing.txt', 'missing.txt']);
        assert.deepEqual(missing2, ['missing.txt']);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('getCommandsRulePath returns correct path', () => {
    const result = getCommandsRulePath('/bundle');
    assert.ok(result.endsWith(path.join('live', 'docs', 'agent-rules', '40-commands.md')));
});

test('getMissingProjectCommands returns all placeholders when content is null', () => {
    const missing = getMissingProjectCommands(null);
    assert.deepEqual(missing, [...PROJECT_COMMAND_PLACEHOLDERS]);
});

test('getMissingProjectCommands returns empty when no placeholders present', () => {
    const missing = getMissingProjectCommands('npm install\nnpm test\n');
    assert.deepEqual(missing, []);
});

test('getMissingProjectCommands detects remaining placeholders', () => {
    const content = 'npm install\n<unit test command>\n';
    const missing = getMissingProjectCommands(content);
    assert.ok(missing.includes('<unit test command>'));
    assert.ok(!missing.includes('<install dependencies command>'));
});

test('extractManagedBlock extracts content between markers', () => {
    const content = [
        'Before',
        MANAGED_START,
        'managed content',
        MANAGED_END,
        'After'
    ].join('\n');

    const block = extractManagedBlock(content);
    assert.ok(block !== null);
    assert.ok(block.includes('managed content'));
    assert.ok(block.startsWith(MANAGED_START));
    assert.ok(block.endsWith(MANAGED_END));
});

test('extractManagedBlock returns null when no markers', () => {
    assert.equal(extractManagedBlock('no markers here'), null);
    assert.equal(extractManagedBlock(''), null);
});

test('readUtf8IfExists returns null for non-existent file', () => {
    assert.equal(readUtf8IfExists('/nonexistent/file.txt'), null);
});

test('readUtf8IfExists reads existing file', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'read-test-'));
    const filePath = path.join(tmpDir, 'test.txt');
    fs.writeFileSync(filePath, 'hello world', 'utf8');

    try {
        const content = readUtf8IfExists(filePath);
        assert.equal(content, 'hello world');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('detectVersionViolations catches version mismatch', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'version-test-'));
    const gaoDir = path.join(tmpDir, 'garda-agent-orchestrator');
    const liveDir = path.join(gaoDir, 'live');
    fs.mkdirSync(liveDir, { recursive: true });
    fs.writeFileSync(path.join(gaoDir, 'VERSION'), '1.0.0', 'utf8');
    fs.writeFileSync(
        path.join(liveDir, 'version.json'),
        JSON.stringify({ Version: '1.0.1', SourceOfTruth: 'Claude', CanonicalEntrypoint: 'CLAUDE.md' }),
        'utf8'
    );

    try {
        const { violations } = detectVersionViolations(tmpDir, 'Claude', 'CLAUDE.md');
        assert.ok(violations.some(v => v.includes('must match')));
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('detectVersionViolations passes when versions match', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'version-test-'));
    const gaoDir = path.join(tmpDir, 'garda-agent-orchestrator');
    const liveDir = path.join(gaoDir, 'live');
    fs.mkdirSync(liveDir, { recursive: true });
    fs.writeFileSync(path.join(gaoDir, 'VERSION'), '1.0.0', 'utf8');
    fs.writeFileSync(
        path.join(liveDir, 'version.json'),
        JSON.stringify({
            Version: '1.0.0',
            SourceOfTruth: 'Claude',
            CanonicalEntrypoint: 'CLAUDE.md',
            ActiveAgentFiles: 'CLAUDE.md'
        }),
        'utf8'
    );

    try {
        const { violations } = detectVersionViolations(tmpDir, 'Claude', 'CLAUDE.md');
        assert.equal(violations.length, 0);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('detectGitignoreViolations detects missing entries', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitignore-test-'));
    fs.writeFileSync(
        path.join(tmpDir, '.gitignore'),
        'node_modules/\nTASK.md\n',
        'utf8'
    );

    try {
        const missing = detectGitignoreViolations(tmpDir, [
            'TASK.md',
            'garda-agent-orchestrator/',
            '.qwen/'
        ]);
        assert.ok(missing.includes('garda-agent-orchestrator/'));
        assert.ok(missing.includes('.qwen/'));
        assert.ok(!missing.includes('TASK.md'));
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('detectGitignoreViolations returns all entries when no .gitignore', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitignore-test-'));
    try {
        const missing = detectGitignoreViolations(tmpDir, ['entry1', 'entry2']);
        assert.deepEqual(missing, ['entry1', 'entry2']);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('detectNestedBundleDuplication returns no duplicates for empty dir', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nested-dup-test-'));
    try {
        const result = detectNestedBundleDuplication(tmpDir);
        assert.equal(result.duplicatesFound, false);
        assert.deepEqual(result.duplicatePaths, []);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('detectNestedBundleDuplication detects nested bundle with launcher', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nested-dup-test-'));
    try {
        const bundlePath = path.join(tmpDir, 'garda-agent-orchestrator');
        const nestedBundlePath = path.join(bundlePath, 'garda-agent-orchestrator');
        const nestedBinDir = path.join(nestedBundlePath, 'bin');
        fs.mkdirSync(nestedBinDir, { recursive: true });
        fs.writeFileSync(path.join(nestedBundlePath, 'bin', 'garda.js'), '#!/usr/bin/env node', 'utf8');

        const result = detectNestedBundleDuplication(tmpDir);
        assert.equal(result.duplicatesFound, true);
        assert.ok(result.duplicatePaths.some(p => p.includes('garda-agent-orchestrator/garda-agent-orchestrator')));
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('detectNestedBundleDuplication ignores nested dir without launcher', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nested-dup-test-'));
    try {
        const bundlePath = path.join(tmpDir, 'garda-agent-orchestrator');
        const nestedBundlePath = path.join(bundlePath, 'garda-agent-orchestrator');
        fs.mkdirSync(nestedBundlePath, { recursive: true });

        const result = detectNestedBundleDuplication(tmpDir);
        assert.equal(result.duplicatesFound, false);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('detectNestedBundleDuplication detects node_modules inside bundle with dist surface', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nested-dup-test-'));
    try {
        const bundlePath = path.join(tmpDir, 'garda-agent-orchestrator');
        fs.mkdirSync(path.join(bundlePath, 'dist', 'src', 'materialization'), { recursive: true });
        fs.mkdirSync(path.join(bundlePath, 'node_modules'), { recursive: true });

        const result = detectNestedBundleDuplication(tmpDir);
        assert.equal(result.duplicatesFound, true);
        assert.ok(result.duplicatePaths.some(p => p.includes('node_modules')));
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});
