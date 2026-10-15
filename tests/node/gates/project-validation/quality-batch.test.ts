import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mock, test } from 'node:test';
import { runClassifyChangeCommand } from '../../../../src/cli/commands/gates';
import { runRecipeCommand } from '../../../../src/cli/commands/gate-flows/command-run/recipe-command-flow';
import { appendTaskEvent } from '../../../../src/gate-runtime/task-events';
import { inspectQualityValidationPhases } from '../../../../src/gates/quality-checklist/quality-checklist-validation-phases';
import { readValidationEvents, withValidationEvidenceBatch,
    type ValidationEvidenceBatch } from '../../../../src/gates/project-validation/attempt-evidence';
import { activationFixture } from './fixtures/activation-fixture';

// Counter hooks call the real production readers in isolated native Git fixtures.
const git = require('../../../../src/core/git-helpers') as typeof import('../../../../src/core/git-helpers');
const identity = require('../../../../src/core/project-validation-identity') as typeof import('../../../../src/core/project-validation-identity');

async function executedFixture() {
    const fixture = activationFixture({ prefix: '', packageCwd: false }, 'tap', 4);
    try {
        execFileSync('git', ['add', '--', fixture.source], { cwd: fixture.repoRoot, stdio: 'pipe' });
        runClassifyChangeCommand({ repoRoot: fixture.repoRoot, taskId: fixture.taskId,
            taskIntent: 'Inspect four authenticated recipe results', outputPath: fixture.preflightPath,
            useStaged: true, emitMetrics: false });
        for (const recipe of fixture.declaration.recipes) {
            const response = await runRecipeCommand({ repoRoot: fixture.repoRoot, taskId: fixture.taskId, recipeId: recipe.id });
            assert.equal(response.exitCode, 0, response.outputLines.join('\n'));
        }
        const inspect = () => inspectQualityValidationPhases({ repoRoot: fixture.repoRoot, taskId: fixture.taskId,
            preflight: JSON.parse(fs.readFileSync(fixture.preflightPath, 'utf8')),
            preflightSha256: createHash('sha256').update(fs.readFileSync(fixture.preflightPath)).digest('hex'),
            matrixRequired: false, matrix: [] })!;
        return { ...fixture, inspect };
    } catch (error) { fixture.cleanup(); throw error; }
}

function assertObserved(phases: ReturnType<typeof inspectQualityValidationPhases>) {
    assert.ok(phases);
    assert.equal(phases.phases.execution, 'OBSERVED');
    assert.equal(phases.phases.semantic, 'PENDING_INDEPENDENT_REVIEW');
    assert.deepEqual(phases.phases.executions.map(result => result.result_status), Array(4).fill('PASSED'));
    assert.equal(new Set(phases.phases.executions.map(result => result.attempt_id)).size, 4);
    assert.equal(phases.phases.obligations.length, 4);
}

test('four recipe inspection shares native staged-scope reads while retaining four distinct results', async () => {
    const fixture = await executedFixture();
    const original = git.runGitBinary;
    let stagedReads = 0;
    const hook = mock.method(git, 'runGitBinary', function (...args: Parameters<typeof original>) {
        if (args[1][0] === 'ls-files') stagedReads++;
        return original(...args);
    });
    try {
        assertObserved(fixture.inspect());
        assert.equal(stagedReads, 2, 'Inspect the native staged scope once at opening and once at closing.');
    } finally { hook.mock.restore(); fixture.cleanup(); }
});

test('recipe inspection rejects source drift during retained reads and accepts restored current source', async () => {
    const fixture = await executedFixture(), sourcePath = path.join(fixture.repoRoot, fixture.source);
    const originalSource = fs.readFileSync(sourcePath), originalRead = identity.readValidationFile;
    let changed = false;
    const hook = mock.method(identity, 'readValidationFile', function (...args: Parameters<typeof originalRead>) {
        const result = originalRead(...args);
        if (!changed && String(args[1]).endsWith('/result.json')) {
            changed = true;
            fs.appendFileSync(sourcePath, ' ');
        }
        return result;
    });
    try {
        assert.throws(() => fixture.inspect(), /scope|changed|identit/iu);
        assert.equal(changed, true, 'Mutation must occur inside the actual retained-result read.');
        hook.mock.restore();
        fs.writeFileSync(sourcePath, originalSource);
        assertObserved(fixture.inspect());
    } finally { hook.mock.restore(); fixture.cleanup(); }
});

test('recipe inspection rejects a native event appended during retained reads and accepts the next stable inspection', async () => {
    const fixture = await executedFixture(), originalRead = identity.readValidationFile;
    let appended = false;
    const hook = mock.method(identity, 'readValidationFile', function (...args: Parameters<typeof originalRead>) {
        const result = originalRead(...args);
        if (!appended && String(args[1]).endsWith('/result.json')) {
            appended = true;
            appendTaskEvent(fixture.bundle, fixture.taskId, 'PROJECT_VALIDATION_INSPECTION_PROBE', 'INFO',
                'Isolated test appends a real native event during read-only inspection.', {}, { actor: 'gate' });
        }
        return result;
    });
    try {
        assert.throws(() => fixture.inspect(), /timeline|changed/iu);
        assert.equal(appended, true, 'The native event must be appended inside the actual retained-result read.');
        hook.mock.restore();
        assertObserved(fixture.inspect());
    } finally { hook.mock.restore(); fixture.cleanup(); }
});

test('shared evidence handles accept only their live native task and cannot be replayed after inspection', () => {
    const fixture = activationFixture({ prefix: '', packageCwd: false });
    try {
        assert.throws(() => readValidationEvents(fixture.repoRoot, fixture.taskId, 'active', {} as ValidationEvidenceBatch), /inactive|another/iu);
        const handle = withValidationEvidenceBatch({ repoRoot: fixture.repoRoot, taskId: fixture.taskId, recipeIds: ['declared'] }, batch => {
            assert.ok(readValidationEvents(fixture.repoRoot, fixture.taskId, 'active', batch)
                .some(event => event.event_type === 'PREFLIGHT_CLASSIFIED'));
            assert.throws(() => readValidationEvents(fixture.repoRoot, 'T-other', 'active', batch), /another/iu);
            return batch;
        });
        assert.throws(() => readValidationEvents(fixture.repoRoot, fixture.taskId, 'active', handle), /inactive/iu);
    } finally { fixture.cleanup(); }
});
