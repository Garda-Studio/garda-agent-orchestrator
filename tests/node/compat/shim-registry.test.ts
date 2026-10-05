import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getGateHelpEntry } from '../../../src/cli/commands/gate-command-help';

import {
    GATE_COMMANDS,
    getAllShimmedGateNames
} from '../../../src/compat/shim-registry';

test('GATE_COMMANDS is a frozen array', () => {
    assert.equal(Object.isFrozen(GATE_COMMANDS), true);
    assert.ok(Array.isArray(GATE_COMMANDS));
});

test('available gates cover the dispatcher and every gate has public help', () => {
    const root = path.resolve('.');
    const dispatcher = fs.readFileSync(path.join(root, 'src/cli/commands/gate-command.ts'), 'utf8');
    const dispatched = [...dispatcher.matchAll(/case '([^']+)':/g)].map(match => match[1]);
    assert.ok(dispatched.length > 0);
    assert.deepEqual([...GATE_COMMANDS].sort(), [...new Set(dispatched)].sort());
    for (const name of GATE_COMMANDS) {
        const help = getGateHelpEntry(name, root);
        assert.ok(help.summary.trim(), name);
        assert.ok(help.usage.some(usage => usage.includes(`gate ${name}`)), name);
    }
});

test('GATE_COMMANDS is non-empty and contains only kebab-case strings', () => {
    assert.ok(GATE_COMMANDS.length > 0);
    for (const name of GATE_COMMANDS) {
        assert.equal(typeof name, 'string');
        assert.match(name, /^[a-z][a-z0-9-]*$/, `${name} must be kebab-case`);
    }
});

test('GATE_COMMANDS includes representative well-known gate names', () => {
    assert.ok(GATE_COMMANDS.includes('validate-manifest'));
    assert.ok(GATE_COMMANDS.includes('enter-task-mode'));
    assert.ok(GATE_COMMANDS.includes('load-rule-pack'));
    assert.ok(GATE_COMMANDS.includes('compile-gate'));
    assert.ok(GATE_COMMANDS.includes('full-suite-validation'));
    assert.ok(GATE_COMMANDS.includes('completion-gate'));
    assert.ok(GATE_COMMANDS.includes('log-task-event'));
    assert.ok(GATE_COMMANDS.includes('human-commit'));
});

test('GATE_COMMANDS has no duplicates', () => {
    const unique = new Set(GATE_COMMANDS);
    assert.equal(unique.size, GATE_COMMANDS.length);
});

test('getAllShimmedGateNames returns an array equal to GATE_COMMANDS', () => {
    assert.deepEqual(getAllShimmedGateNames(), [...GATE_COMMANDS]);
});

test('getAllShimmedGateNames returns a new copy each time (not the same reference)', () => {
    const a = getAllShimmedGateNames();
    const b = getAllShimmedGateNames();
    assert.notEqual(a, b);
    assert.deepEqual(a, b);
});

test('mutating the returned array does not affect GATE_COMMANDS', () => {
    const copy = getAllShimmedGateNames();
    copy.push('fake-gate');
    assert.ok(!GATE_COMMANDS.includes('fake-gate'));
    assert.equal(GATE_COMMANDS.length, copy.length - 1);
});
