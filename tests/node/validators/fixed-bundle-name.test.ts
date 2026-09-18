import test from 'node:test';
import assert from 'node:assert/strict';

import {
    getBaseRequiredPaths,
    BASE_REQUIRED_PATHS,
    getBundlePath,
    buildRequiredPaths
} from '../../../src/validators/workspace-layout';

test('getBaseRequiredPaths returns paths using the fixed bundle name', () => {
    const paths = getBaseRequiredPaths();
    assert.ok(paths.length > 25);
    assert.ok(paths.includes('TASK.md'));
    assert.ok(paths.includes('garda-agent-orchestrator/VERSION'));
    assert.ok(paths.includes('garda-agent-orchestrator/bin/garda.js'));
    assert.ok(paths.includes('garda-agent-orchestrator/live/config/review-capabilities.json'));
    for (const p of paths) {
        if (p === 'TASK.md') continue;
        assert.ok(p.startsWith('garda-agent-orchestrator/'), `Expected "${p}" to start with the fixed bundle name`);
    }
});

test('BASE_REQUIRED_PATHS is backwards compatible with default bundle name', () => {
    assert.ok(Array.isArray(BASE_REQUIRED_PATHS));
    assert.ok(BASE_REQUIRED_PATHS.length > 25);
    assert.ok(Object.isFrozen(BASE_REQUIRED_PATHS));
    assert.ok(BASE_REQUIRED_PATHS.includes('garda-agent-orchestrator/dist/src/index.js'));
    assert.ok(!BASE_REQUIRED_PATHS.some(requiredPath => /^garda-agent-orchestrator\/src(?:\/|$)/.test(requiredPath)));
});

test('getBundlePath uses default bundle name', () => {
    const result = getBundlePath('/projects/my-app');
    assert.ok(result.includes('garda-agent-orchestrator'));
});

test('getBundlePath ignores non-default bundle override', () => {
    const result = getBundlePath('/projects/my-app', 'custom-bundle');
    assert.ok(result.endsWith('garda-agent-orchestrator'));
});

test('buildRequiredPaths ignores non-default bundleName option', () => {
    const paths = buildRequiredPaths({ bundleName: 'alt-orchestrator' });
    assert.ok(paths.some(p => p.startsWith('garda-agent-orchestrator/')));
    assert.ok(!paths.some(p => p.startsWith('alt-orchestrator/')));
    assert.ok(paths.some(p => p.includes('00-core.md')));
});
