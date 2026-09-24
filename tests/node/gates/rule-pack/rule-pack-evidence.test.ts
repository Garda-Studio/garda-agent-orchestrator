import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';

import { getRulePackEvidence } from '../../../../src/gates/rule-pack/rule-pack-evidence';
import { createRulePackFixture, TASK_ID } from './rule-pack-test-fixtures';

test('rule-pack evidence accepts bound task-entry and post-preflight stages', (t) => {
    const fixture = createRulePackFixture(t);
    const entry = getRulePackEvidence(fixture.repoRoot, TASK_ID, 'TASK_ENTRY');
    const post = getRulePackEvidence(fixture.repoRoot, TASK_ID, 'POST_PREFLIGHT', {
        preflightPath: fixture.preflightPath
    });
    assert.equal(entry.evidence_status, 'PASS');
    assert.equal(post.evidence_status, 'PASS');
    assert.equal(post.binding_equivalent_to_current_preflight, true);
    assert.equal(post.evidence_preflight_path, fixture.preflightPath.replace(/\\/gu, '/'));
});

test('rule-pack evidence rejects missing, malformed, foreign and stage-invalid artifacts', (t) => {
    const fixture = createRulePackFixture(t);
    const valid = fixture.readArtifact();
    assert.equal(getRulePackEvidence(fixture.repoRoot, null, 'TASK_ENTRY').evidence_status, 'TASK_ID_MISSING');
    fs.unlinkSync(fixture.artifactPath);
    assert.equal(getRulePackEvidence(fixture.repoRoot, TASK_ID, 'TASK_ENTRY').evidence_status,
        'EVIDENCE_FILE_MISSING');
    fs.writeFileSync(fixture.artifactPath, '{', 'utf8');
    assert.equal(getRulePackEvidence(fixture.repoRoot, TASK_ID, 'TASK_ENTRY').evidence_status,
        'EVIDENCE_INVALID_JSON');
    fixture.writeArtifact({ ...valid, task_id: 'T-FOREIGN' });
    assert.equal(getRulePackEvidence(fixture.repoRoot, TASK_ID, 'TASK_ENTRY').evidence_status,
        'EVIDENCE_TASK_MISMATCH');
    const wrongStage = structuredClone(valid);
    wrongStage.stages.task_entry!.stage = 'POST_PREFLIGHT';
    fixture.writeArtifact(wrongStage);
    assert.equal(getRulePackEvidence(fixture.repoRoot, TASK_ID, 'TASK_ENTRY').evidence_status,
        'EVIDENCE_STAGE_INVALID');
    fixture.writeArtifact({ ...valid, stages: {} });
    assert.equal(getRulePackEvidence(fixture.repoRoot, TASK_ID, 'TASK_ENTRY').evidence_status,
        'EVIDENCE_STAGE_MISSING');
});

test('rule-pack evidence rejects stale hashes, incomplete rule sets and foreign timeline paths', (t) => {
    const fixture = createRulePackFixture(t);
    const valid = fixture.readArtifact();
    const corePath = valid.stages.task_entry!.loaded_rule_files.find((file) => file.endsWith('/00-core.md'))!;
    fs.appendFileSync(corePath, '\nchanged', 'utf8');
    const stale = getRulePackEvidence(fixture.repoRoot, TASK_ID, 'TASK_ENTRY');
    assert.equal(stale.evidence_status, 'EVIDENCE_LOADED_RULE_STALE');
    assert.equal(stale.stale_loaded_rule_file, corePath);

    fs.writeFileSync(corePath, '# 00-core.md\n', 'utf8');
    const incomplete = structuredClone(valid);
    incomplete.stages.task_entry!.loaded_rule_files = [];
    fixture.writeArtifact(incomplete);
    assert.equal(getRulePackEvidence(fixture.repoRoot, TASK_ID, 'TASK_ENTRY').evidence_status,
        'EVIDENCE_REQUIRED_RULES_MISSING');

    fixture.writeArtifact(valid);
    fixture.append('RULE_PACK_LOADED', {
        stage: 'TASK_ENTRY', artifact_path: path.join(fixture.repoRoot, 'foreign.json').replace(/\\/gu, '/')
    });
    assert.equal(getRulePackEvidence(fixture.repoRoot, TASK_ID, 'TASK_ENTRY').evidence_status,
        'EVIDENCE_ARTIFACT_PATH_MISMATCH');
});

test('post-preflight evidence rejects missing and mismatched preflight bindings', (t) => {
    const fixture = createRulePackFixture(t);
    const valid = fixture.readArtifact();
    assert.equal(getRulePackEvidence(fixture.repoRoot, TASK_ID, 'POST_PREFLIGHT').evidence_status,
        'EVIDENCE_PREFLIGHT_REQUIRED');
    const foreignPath = structuredClone(valid);
    foreignPath.stages.post_preflight!.preflight_path = path.join(fixture.repoRoot, 'foreign.json');
    fixture.writeArtifact(foreignPath);
    assert.equal(getRulePackEvidence(fixture.repoRoot, TASK_ID, 'POST_PREFLIGHT', {
        preflightPath: fixture.preflightPath
    }).evidence_status, 'EVIDENCE_PREFLIGHT_PATH_MISMATCH');

    fixture.writeArtifact(valid);
    const preflight = JSON.parse(fs.readFileSync(fixture.preflightPath, 'utf8')) as Record<string, unknown>;
    fs.writeFileSync(fixture.preflightPath, JSON.stringify({ ...preflight, fixture_revision: 2 }), 'utf8');
    assert.equal(getRulePackEvidence(fixture.repoRoot, TASK_ID, 'POST_PREFLIGHT', {
        preflightPath: fixture.preflightPath
    }).evidence_status, 'EVIDENCE_PREFLIGHT_HASH_MISMATCH');
});
