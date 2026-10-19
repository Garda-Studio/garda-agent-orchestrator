import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { getRepoRoot } from '../../../scripts/node-foundation/build';
import { getProjectDiscovery } from '../../../src/materialization/project-discovery';
import { classifyChange, getClassificationConfig } from '../../../src/gates/preflight/classify-change';

interface StackFixture {
    source: string;
    test: string;
    dependency: string;
    detected_stack: string | null;
}

const FIXTURES_ROOT = path.join(getRepoRoot(), 'tests', 'fixtures', 'stacks');
const ALL_CAPABILITIES = {
    code: true, db: true, security: true, refactor: true, api: true,
    test: true, performance: true, infra: true, dependency: true
};

function copyFixture(name: string): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `garda-stack-${name}-`));
    fs.cpSync(path.join(FIXTURES_ROOT, name), root, { recursive: true });
    fs.rmSync(path.join(root, 'stack-fixture.json'));
    return root;
}

function classify(root: string, files: string[]) {
    return classifyChange({
        repoRoot: root,
        normalizedFiles: files,
        changedLinesTotal: 6,
        changedFileStats: Object.fromEntries(files.map(file => [file, { additions: 4, deletions: 2, changed_lines: 6 }])),
        classificationConfig: getClassificationConfig(root),
        reviewCapabilities: ALL_CAPABILITIES
    });
}

const fixtureNames = fs.readdirSync(FIXTURES_ROOT).filter(name => (
    fs.existsSync(path.join(FIXTURES_ROOT, name, 'stack-fixture.json'))
)).sort();

test('stack fixture catalog covers mainstream, non-mainstream and unknown stacks', () => {
    assert.ok(fixtureNames.length >= 8, fixtureNames.join(','));
    assert.ok(fixtureNames.some(name => name.startsWith('unknown-')));
});

for (const name of fixtureNames) {
    test(`stack-neutral discovery and classification for the ${name} fixture project`, t => {
        const fixture = JSON.parse(fs.readFileSync(path.join(FIXTURES_ROOT, name, 'stack-fixture.json'), 'utf8')) as StackFixture;
        const root = copyFixture(name);
        t.after(() => fs.rmSync(root, { recursive: true, force: true }));

        const discovery = getProjectDiscovery(root);
        if (fixture.detected_stack) {
            assert.ok(discovery.detectedStacks.includes(fixture.detected_stack), discovery.detectedStacks.join(','));
        } else {
            // Unknown stacks must stay honest: no invented commands, explicit configuration required.
            assert.deepEqual(discovery.detectedStacks, []);
            assert.deepEqual(discovery.suggestedCompileGateCommands, []);
            assert.equal(discovery.suggestedFullSuiteValidationCommand, null);
        }

        const source = classify(root, [fixture.source]);
        assert.equal(source.scope_category, 'code', `${fixture.source}: ${source.scope_category_reasons.join(';')}`);
        assert.equal(source.required_reviews.code, true, fixture.source);

        const testOnly = classify(root, [fixture.test]);
        assert.equal(testOnly.scope_category, 'test-only', `${fixture.test}: ${testOnly.scope_category_reasons.join(';')}`);
        assert.equal(testOnly.triggers.test, true, fixture.test);

        const dependency = classify(root, [fixture.dependency]);
        assert.equal(dependency.triggers.dependency, true, fixture.dependency);
        assert.equal(dependency.required_reviews.dependency, true, fixture.dependency);

        const mixed = classify(root, [fixture.source, fixture.test]);
        assert.equal(mixed.required_reviews.code, true, `${fixture.source}+${fixture.test}`);
    });
}
