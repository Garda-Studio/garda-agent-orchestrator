import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { getRepoRoot } from '../../../scripts/node-foundation/build';
import { copyDirectoryRecursive } from '../../../src/materialization/init/init-filesystem';
import { readBaselineSkillManifest } from '../../../src/runtime/skill-manifest';

function materializeEngineeringGuidance(context: TestContext, skillId: 'refactor-playbook' | 'architecture-review') {
    const bundleRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-engineering-guidance-'));
    context.after(() => {
        assert.equal(path.dirname(bundleRoot), path.resolve(os.tmpdir()));
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    });
    const sourceRoot = path.join(getRepoRoot(), 'template', 'skill-packs', 'quality-architecture',
        'skills', skillId);
    const skillRoot = path.join(bundleRoot, 'live', 'skills', skillId);
    const customPath = path.join(bundleRoot, 'live', 'skills', 'project-specialist', 'SKILL.md');
    const memoryPath = path.join(bundleRoot, 'live', 'docs', 'project-memory', 'compact.md');
    const customBytes = Buffer.from('# Project-owned specialist\n');
    const memoryBytes = Buffer.from('# User-owned project invariants\n');
    for (const [file, bytes] of [[customPath, customBytes], [memoryPath, memoryBytes]] as const) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, bytes);
    }
    copyDirectoryRecursive(sourceRoot, skillRoot, { destinationRoot: bundleRoot });
    const manifest = readBaselineSkillManifest(skillRoot);
    assert.equal(manifest.id, skillId);
    assert.deepEqual(manifest.references, ['checklist.md']);
    for (const relative of ['SKILL.md', 'skill.json', 'references/checklist.md']) {
        assert.deepEqual(fs.readFileSync(path.join(skillRoot, relative)),
            fs.readFileSync(path.join(sourceRoot, relative)));
    }
    assert.deepEqual(fs.readFileSync(customPath), customBytes);
    assert.deepEqual(fs.readFileSync(memoryPath), memoryBytes);
    return {
        instructions: fs.readFileSync(path.join(skillRoot, 'SKILL.md'), 'utf8'),
        checklist: fs.readFileSync(path.join(skillRoot, 'references', 'checklist.md'), 'utf8')
    };
}

test('materialized refactor guidance permits coherent private callers while keeping invariant and authorization boundaries', context => {
    const { instructions, checklist } = materializeEngineeringGuidance(context, 'refactor-playbook');
    for (const text of [instructions, checklist]) {
        assert.match(text, /smallest coherent change/iu);
        assert.match(text, /private module and its required callers/iu);
        assert.match(text, /unrelated.*semantic|unrelated feature or bug-fix/iu);
        assert.match(text, /explicitly authorized necessary coupled corrections/iu);
        assert.match(text, /unaffected invariants/iu);
        assert.doesNotMatch(text, /never refactor.*module and its consumers|no change modifies a module and its consumers|do not refactor a module and its dependents|each commit.*purely structural|never mix the two in one commit/iu);
    }
    assert.match(instructions, /intentional behavior delta.*test and review both parts together/u);
    assert.match(checklist, /documented, tested and reviewed with the coherent unit/u);
});

test('private rename and public migration examples select compatibility from actual consumers', context => {
    const { instructions, checklist } = materializeEngineeringGuidance(context, 'refactor-playbook');
    const privateExample = instructions.split('### Private module rename\n')[1]?.split('\n### ')[0];
    const publicExample = instructions.split('### Public API migration\n')[1]?.split('\n## ')[0];
    assert.ok(privateExample);
    assert.ok(publicExample);
    assert.match(privateExample, /`parseLine` to `parseOrderLine`/u);
    assert.match(privateExample, /required callers together.*same bounded change/u);
    assert.match(privateExample, /input\/output, error and side-effect invariants/u);
    assert.match(privateExample, /no actual external consumers.*needs no re-export bridge/u);
    assert.match(publicExample, /`getInvoice` with actual external consumers/u);
    assert.match(publicExample, /`loadInvoice`.*thin adapter preserving the existing public contract/u);
    assert.match(publicExample, /including errors and side effects/u);
    assert.match(publicExample, /validate old and new consumers/u);
    assert.match(publicExample, /only after consumer migration or explicit approval/u);
    assert.match(checklist, /Actual external consumers retain their public contract/u);
    assert.match(checklist, /Private-only names and known callers can migrate together/u);
});

test('behavior checkpoints preserve mandatory gates without per-edit suites or commit-revert proof', context => {
    const { instructions, checklist } = materializeEngineeringGuidance(context, 'refactor-playbook');
    for (const text of [instructions, checklist]) {
        assert.match(text, /meaningful behavior checkpoints/iu);
        assert.match(text, /affected checks/iu);
        assert.match(text, /mandatory compile, test, review and completion gates/iu);
        assert.match(text, /reversible change boundary/iu);
        assert.doesNotMatch(text, /after every atomic move|tests re-run after every atomic refactor step|type-check and lint pass at each intermediate commit|verify that reverting the most recent commit|reverting the latest commit restores a green test suite/iu);
    }
    assert.match(instructions, /do not require a full suite after every atomic edit/u);
    assert.match(instructions, /neither an actual intermediate commit nor an actual revert as proof/u);
    assert.match(checklist, /an actual intermediate commit or actual revert is not required as proof/u);
    assert.match(checklist, /No irreversible side effects.*bundled with the refactor/u);
});

test('materialized architecture guidance evaluates local chains without a hop-count async mandate', context => {
    const { instructions, checklist } = materializeEngineeringGuidance(context, 'architecture-review');
    for (const text of [instructions, checklist]) {
        assert.match(text, /in-process/iu);
        assert.match(text, /input\/output, errors, ordering, data ownership/iu);
        assert.match(text, /hop count alone cannot mandate an async boundary/iu);
        assert.doesNotMatch(text, /synchronous chains longer than two hops|no synchronous call chain exceeds two hops|every new inter-service or cross-module synchronous call has a timeout and retry budget/iu);
    }
    const localExample = instructions.split('### Local call chain\n')[1]?.split('\n### ')[0];
    assert.ok(localExample);
    assert.match(localExample, /`OrderController → OrderService → OrderCalculator → OrderFormatter`/u);
    assert.match(localExample, /one process.*no external I\/O/u);
    assert.match(localExample, /Three local hops do not require an async boundary, per-hop timeouts or retries by themselves/u);
    assert.match(localExample, /input\/output, error, ordering and ownership invariants/u);
});

test('remote boundary guidance propagates one deadline without replenishing each downstream budget', context => {
    const { instructions, checklist } = materializeEngineeringGuidance(context, 'architecture-review');
    for (const text of [instructions, checklist]) {
        assert.match(text, /end-to-end deadline/iu);
        assert.match(text, /remaining budget/iu);
        assert.match(text, /cancellation/iu);
        assert.match(text, /idempotent or explicitly safe operation semantics/iu);
        assert.match(text, /circuit-breaker or bulkhead/iu);
        assert.match(text, /actual partial-failure risk|actual latency, isolation and partial-failure risk/iu);
    }
    const remoteExample = instructions.split('### Remote timeout propagation\n')[1]?.split('\n## ')[0];
    assert.ok(remoteExample);
    assert.match(remoteExample, /`API → PricingService → InventoryService`/u);
    assert.match(remoteExample, /one request deadline `D`/u);
    assert.match(remoteExample, /PricingService forwards only the remaining budget to InventoryService/u);
    assert.match(remoteExample, /downstream timeouts cannot extend `D`/u);
    assert.match(remoteExample, /Propagate cancellation and stop when the budget is exhausted/u);
    assert.match(checklist, /do not reset a full timeout at each hop/u);
});
