import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';

import {
    buildRulePackBindingSha256,
    getPostPreflightRulePackRebindDecision,
    getPostPreflightSequenceEvidence,
    getPreflightClassificationBinding,
    getStageRulePackBindingSha256
} from '../../../../src/gates/rule-pack/rule-pack-binding';
import { createRulePackFixture, TASK_ID } from './rule-pack-test-fixtures';

test('binding hash ignores volatile timestamps but binds preflight fields and changed file bytes', (t) => {
    const fixture = createRulePackFixture(t);
    const base = {
        repoRoot: fixture.repoRoot,
        preflightPath: fixture.preflightPath,
        effectiveDepth: 2,
        requiredRuleFiles: fixture.readArtifact().stages.post_preflight!.required_rule_files,
        requiredReviews: fixture.readArtifact().stages.post_preflight!.required_reviews
    };
    assert.equal(buildRulePackBindingSha256({ ...base, preflightPath: null }), null);
    const preflightPayload = JSON.parse(fs.readFileSync(fixture.preflightPath, 'utf8')) as Record<string, unknown>;
    const original = buildRulePackBindingSha256({ ...base, preflightPayload });
    assert.equal(buildRulePackBindingSha256({ ...base, preflightPayload: {
        ...preflightPayload, timestamp_utc: 'different'
    } }), original);
    assert.notEqual(buildRulePackBindingSha256({ ...base, preflightPayload: {
        ...preflightPayload, task_id: 'T-FOREIGN'
    } }), original);
    fs.writeFileSync(fixture.changedFilePath, 'export const changed = true;\n', 'utf8');
    assert.notEqual(buildRulePackBindingSha256({ ...base, preflightPayload }), original);
    assert.equal(getStageRulePackBindingSha256({ preflight_rule_pack_binding_sha256: ' ABC ' }), 'abc');
    assert.equal(getStageRulePackBindingSha256({}), null);
});

test('classification and post-preflight sequence bind to the latest task evidence', (t) => {
    const fixture = createRulePackFixture(t);
    const classified = getPreflightClassificationBinding(fixture.repoRoot, TASK_ID, fixture.preflightPath);
    assert.deepEqual(classified.violations, []);
    assert.ok(classified.latest_preflight_sequence);
    const sequence = getPostPreflightSequenceEvidence(fixture.repoRoot, TASK_ID, fixture.preflightPath);
    assert.deepEqual(sequence.violations, []);
    assert.equal(sequence.binding_equivalent_to_current_preflight, true);
    assert.ok(sequence.latest_post_preflight_rule_pack_sequence! > sequence.latest_preflight_sequence!);

    const foreignPreflightPath = path.join(path.dirname(fixture.preflightPath), 'foreign-preflight.json');
    const foreign = getPreflightClassificationBinding(fixture.repoRoot, TASK_ID, foreignPreflightPath);
    assert.match(foreign.violations.join(' '), /not the latest PREFLIGHT_CLASSIFIED/u);
    fixture.append('PREFLIGHT_CLASSIFIED', { output_path: fixture.preflightPath.replace(/\\/gu, '/') });
    const equivalent = getPostPreflightSequenceEvidence(fixture.repoRoot, TASK_ID, fixture.preflightPath);
    assert.deepEqual(equivalent.violations, []);
    assert.equal(equivalent.binding_equivalent_to_current_preflight, true);
});

test('sequence rejects stale non-equivalent post-preflight evidence', (t) => {
    const fixture = createRulePackFixture(t);
    const preflight = JSON.parse(fs.readFileSync(fixture.preflightPath, 'utf8')) as Record<string, unknown>;
    fs.writeFileSync(fixture.preflightPath, JSON.stringify({ ...preflight, fixture_revision: 2 }), 'utf8');
    fixture.append('PREFLIGHT_CLASSIFIED', { output_path: fixture.preflightPath.replace(/\\/gu, '/') });
    const sequence = getPostPreflightSequenceEvidence(fixture.repoRoot, TASK_ID, fixture.preflightPath);
    assert.equal(sequence.binding_equivalent_to_current_preflight, false);
    assert.match(sequence.violations.join(' '), /does not occur after the latest PREFLIGHT_CLASSIFIED/u);
});

test('rebind accepts current rules and rejects missing stage, changed decisions and stale rule bytes', (t) => {
    const fixture = createRulePackFixture(t);
    const current = getPostPreflightRulePackRebindDecision(fixture.repoRoot, TASK_ID, fixture.preflightPath);
    assert.equal(current.can_bind, true);
    assert.ok(current.previous_rule_pack_sequence);

    const artifact = fixture.readArtifact();
    delete artifact.stages.post_preflight;
    fixture.writeArtifact(artifact);
    assert.match(getPostPreflightRulePackRebindDecision(
        fixture.repoRoot, TASK_ID, fixture.preflightPath
    ).reason, /No prior POST_PREFLIGHT/u);

    artifact.stages.post_preflight = fixture.readArtifact().stages.task_entry;
    fixture.writeArtifact(artifact);
    const mismatched = getPostPreflightRulePackRebindDecision(fixture.repoRoot, TASK_ID, fixture.preflightPath);
    assert.equal(mismatched.can_bind, false);

    const rebuilt = createRulePackFixture(t);
    const corePath = rebuilt.readArtifact().stages.post_preflight!.loaded_rule_files
        .find((file) => file.endsWith('/00-core.md'))!;
    fs.appendFileSync(corePath, '\nchanged', 'utf8');
    const stale = getPostPreflightRulePackRebindDecision(rebuilt.repoRoot, TASK_ID, rebuilt.preflightPath);
    assert.equal(stale.can_bind, false);
    assert.match(stale.reason, /changed or cannot be hashed/u);
});
