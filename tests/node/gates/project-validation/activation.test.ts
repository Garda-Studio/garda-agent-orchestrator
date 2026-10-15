import { it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { EXIT_GATE_FAILURE } from '../../../../src/cli/exit-codes';
import { readValidationReviewObligations } from '../../../../src/gates/review/validation-obligations';
import { getValidationTerminalViolations } from '../../../../src/gates/review/validation-terminal';
import { activationFixture } from './fixtures/activation-fixture';

function terminal(f: ReturnType<typeof activationFixture>) {
    return getValidationTerminalViolations({ repoRoot: f.repoRoot, taskId: f.taskId, preflightPath: f.preflightPath,
        preflight: JSON.parse(fs.readFileSync(f.preflightPath, 'utf8')), requiredReviews: { code: true, test: true }, artifacts: {} });
}

for (const layout of [{ name: 'root files without a conventional project manifest', prefix: '', packageCwd: false },
    { name: 'package-local monorepo validation', prefix: 'packages/alpha', packageCwd: true },
    { name: 'an unfamiliar component and extensionless custom driver', prefix: 'component', packageCwd: false }]) {
    it(`qualifies real declared execution for ${layout.name} without semantic self-acceptance`, async () => {
        const f = activationFixture(layout);
        try {
            assert.equal(fs.existsSync(path.join(f.repoRoot, 'package.json')), false);
            assert.equal(fs.existsSync(path.join(f.repoRoot, 'src')), false);
            const beforeConfig = JSON.parse(fs.readFileSync(f.configPath, 'utf8'));
            const { response, snapshot, attempt, result } = await f.execute();
            assert.equal(response.exitCode, 0); assert.equal(attempt.exit_code, 0);
            assert.equal(result.status, 'PASSED'); assert.equal(attempt.timed_out, false);
            assert.equal(snapshot.recipe.cwd, layout.packageCwd ? layout.prefix : '.');
            assert.equal(snapshot.recipe.targets[0].selector, f.selector);
            assert.ok(snapshot.recipe.inputs.some(input => input.path === f.source && input.role === 'source'));
            assert.deepEqual(JSON.parse(fs.readFileSync(f.configPath, 'utf8')), beforeConfig);
            f.publishQuality();
            const projected = readValidationReviewObligations(f);
            assert.deepEqual(projected.semantic_review_lanes, ['code', 'test']);
            assert.equal(projected.obligations.length, 1);
            assert.equal(projected.obligations[0].source_identity.path, f.target);
            assert.equal(projected.obligations[0].execution, 'OBSERVED');
            assert.equal(projected.obligations[0].result_status, 'PASSED');
            // No fixture reviewer, receipt, DONE status or completion PASS is manufactured.
            assert.ok(terminal(f).some(error => /independent semantic report is missing or unreadable/u.test(error)));
            fs.appendFileSync(path.join(f.repoRoot, f.source), ' ');
            assert.throws(() => readValidationReviewObligations(f), /scope|changed|identity|fingerprint|stale/iu);
        } finally { await f.cleanup(); }
    });
}

it('keeps an actual opaque successful process unresolved at the terminal boundary', async () => {
    const f = activationFixture({ prefix: '', packageCwd: false }, 'opaque');
    try {
        const { response, attempt, result } = await f.execute();
        assert.equal(attempt.exit_code, 0); assert.equal(response.exitCode, EXIT_GATE_FAILURE);
        assert.equal(result.status, 'UNRESOLVED');
        f.publishQuality();
        const projected = readValidationReviewObligations(f);
        assert.equal(projected.obligations[0].execution, 'OBSERVED');
        assert.equal(projected.obligations[0].result_status, 'UNRESOLVED');
        assert.ok(terminal(f).some(error => /independent semantic report is missing or unreadable/u.test(error)));
    } finally { await f.cleanup(); }
});

it('rejects unsupported declaration versions before changing audited project settings', async () => {
    const f = activationFixture({ prefix: '', packageCwd: false });
    try {
        const before = fs.readFileSync(f.configPath);
        fs.writeFileSync(f.declarationPath, JSON.stringify({ ...f.declaration, schema_version: 2 }));
        assert.throws(() => f.admit(), /schema|version/iu);
        assert.deepEqual(fs.readFileSync(f.configPath), before);
    } finally { await f.cleanup(); }
});
