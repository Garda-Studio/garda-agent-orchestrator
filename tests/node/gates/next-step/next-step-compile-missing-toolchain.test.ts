import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { readCompileReadiness } from '../../../../src/gates/next-step/next-step-compile-readiness';
import { formatMissingExecutableMessage } from '../../../../src/cli/gate-cli/gates-subprocess';

test('compile readiness names a missing toolchain instead of only asking to retry', t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-missing-toolchain-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const reviewsRoot = path.join(root, 'reviews');
    fs.mkdirSync(reviewsRoot);
    const missing = formatMissingExecutableMessage('go');
    fs.writeFileSync(path.join(reviewsRoot, 'T-1-compile-gate.json'), JSON.stringify({
        task_id: 'T-1', event_source: 'compile-gate', status: 'FAILED', outcome: 'FAIL',
        error: `Compile command #1 exited with code 1. ${missing} NextStep: run next-step before retrying compile-gate.`
    }));
    const readiness = readCompileReadiness(root, reviewsRoot, path.join(root, 'events'), 'T-1', path.join(root, 'missing-preflight.json'));
    assert.equal(readiness.ready, false);
    assert.match(readiness.reason, /go is required but was not found in PATH\./u);
    assert.match(readiness.reason, /Install or expose the toolchain that provides 'go'/u);
    assert.match(readiness.reason, /--compile-gate-command/u);
    assert.doesNotMatch(readiness.reason, /NextStep:/u);
});
