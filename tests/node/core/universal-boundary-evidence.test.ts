import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as boundary from '../../../src/core/trust-boundary-analysis';
import { readValidationFile, validationDigest } from '../../../src/core/project-validation-identity';
import type { ValidationFileIdentity } from '../../../src/core/project-validation-contract';

type BoundAssessment = boundary.TrustBoundaryMatrixAssessment & { source_bindings_sha256: string };
type BindSources = (matrix: unknown, options: {
    repoRoot: string; expectedSources?: readonly ValidationFileIdentity[];
}) => BoundAssessment;

function bindSources(matrix: unknown, options: Parameters<BindSources>[1]): BoundAssessment {
    return (boundary as unknown as { assessBoundTrustBoundaryMatrix: BindSources })
        .assessBoundTrustBoundaryMatrix(matrix, options);
}

function matrix(references: string[]) {
    return [{
        boundary_id: 'AUTH', boundary: 'Запрос к защищённому ресурсу',
        authority_source: 'Current project authorization', mutable_inputs: ['request'],
        integrity_evidence: ['bound source and actual case evidence'],
        canonical_reconstruction: 'Current source, execution and independent semantic review',
        toctou_replay: 'Source and execution identities must remain current',
        negative_paths: [{ kind: 'other', scenario: 'Проверка拒绝',
            expected_behavior: 'Недействительный запрос отклонён', evidence_files: references }]
    }];
}

function fixture(files: Record<string, string>) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-universal-boundary-'));
    for (const [relative, content] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
        fs.writeFileSync(path.join(root, relative), content);
    }
    return { root, remove: () => fs.rmSync(root, { recursive: true, force: true }) };
}

describe('universal boundary source evidence', () => {
    it('binds ordinary Java/JUnit camelCase evidence without a project declaration or JS grammar', () => {
        const source = 'api-gateway/src/test/java/example/GatewaySecurityCompatibilityTest.java';
        const caseId = 'privateRequestRejectsInvalidBearerToken';
        const f = fixture({ [source]: `@Test void ${caseId}() { assertThat(upstreamRequests).hasValue(0); }` });
        try {
            const result = bindSources(matrix([`${source}#${caseId}`]), { repoRoot: f.root });
            assert.deepEqual(result.violations, []);
            assert.equal(result.structural_status, 'BOUND');
            assert.equal(result.semantic_status, 'PENDING_INDEPENDENT_REVIEW');
            assert.equal(result.source_evidence?.[0].case_id, caseId);
            assert.equal(result.source_evidence?.[0].source_identity.sha256,
                validationDigest(fs.readFileSync(path.join(f.root, source))));
            assert.equal(result.source_evidence?.[0].syntax_status, 'UNRESOLVED');
            assert.equal(fs.existsSync(path.join(f.root, 'project-validation.json')), false);
        } finally { f.remove(); }
    });

    it('uses the same source identity contract for JavaScript and unconventional Unicode source paths', () => {
        const f = fixture({
            'RootSuite.js': "test('customerAccess', () => { assert.equal(response.status, 403); });",
            'проверки/λ': 'unknown project test syntax'
        });
        try {
            const result = bindSources(matrix(['RootSuite.js#customerAccess', 'проверки/λ#任意 case']),
                { repoRoot: f.root });
            assert.deepEqual(result.violations, []);
            assert.deepEqual(result.source_evidence?.map(item => [item.case_id, item.selector, item.syntax_status]),
                [['customerAccess', 'customerAccess', 'UNRESOLVED'], ['任意 case', '任意 case', 'UNRESOLVED']]);
            assert.equal(result.semantic_status, 'PENDING_INDEPENDENT_REVIEW');
        } finally { f.remove(); }
    });

    it('never turns a source binding or an inert test body into execution or semantic success', () => {
        const f = fixture({ 'Source': '// nonexistent case and no assertions' });
        try {
            const result = bindSources(matrix(['Source#opaque-case']), { repoRoot: f.root });
            assert.equal(result.structural_status, 'BOUND');
            assert.equal(result.semantic_status, 'PENDING_INDEPENDENT_REVIEW');
            assert.equal(result.source_evidence?.[0].syntax_status, 'UNRESOLVED');
            assert.equal('execution' in result, false);
            assert.equal('passed' in result, false);
        } finally { f.remove(); }
    });

    it('rejects malformed, missing and out-of-root references instead of binding arbitrary evidence', () => {
        const f = fixture({ 'Source': 'source' });
        try {
            const malformed = bindSources(matrix(['Source']), { repoRoot: f.root });
            const missing = bindSources(matrix(['Missing#case']), { repoRoot: f.root });
            const traversal = bindSources(matrix(['../Source#case']), { repoRoot: f.root });
            assert.deepEqual([malformed, missing, traversal].map(item => item.structural_status),
                ['INVALID', 'INVALID', 'INVALID']);
            assert.equal([malformed, missing, traversal].every(item => item.violations.length > 0), true);
        } finally { f.remove(); }
    });

    it('rejects source substitution against a retained source identity', () => {
        const f = fixture({ 'Source': 'original source' });
        try {
            const expected = readValidationFile(f.root, 'Source').identity;
            const first = bindSources(matrix(['Source#case']), { repoRoot: f.root, expectedSources: [expected] });
            assert.equal(first.structural_status, 'BOUND');
            fs.writeFileSync(path.join(f.root, 'Source'), 'substituted source');
            const changed = bindSources(matrix(['Source#case']), { repoRoot: f.root, expectedSources: [expected] });
            assert.equal(changed.structural_status, 'INVALID');
            assert.match(changed.violations.join(' '), /identity|changed/i);
        } finally { f.remove(); }
    });

    it('keeps the exact retained source set and does not accept ambiguous identities', () => {
        const f = fixture({ 'Source': 'source', 'Foreign': 'foreign' });
        try {
            const identity = readValidationFile(f.root, 'Source').identity;
            const foreign = readValidationFile(f.root, 'Foreign').identity;
            const duplicated = bindSources(matrix(['Source#case']),
                { repoRoot: f.root, expectedSources: [identity, identity] });
            const incomplete = bindSources(matrix(['Source#case']), { repoRoot: f.root, expectedSources: [] });
            const excessive = bindSources(matrix(['Source#case']),
                { repoRoot: f.root, expectedSources: [identity, foreign] });
            assert.deepEqual([duplicated, incomplete, excessive].map(item => item.structural_status),
                ['INVALID', 'INVALID', 'INVALID']);
        } finally { f.remove(); }
    });

    it('counts a shared source once against the source byte budget while retaining every exact case', () => {
        const f = fixture({ 'LargeSource': 'x'.repeat(6 * 1024 * 1024) });
        try {
            const result = bindSources(matrix(['LargeSource#one', 'LargeSource#two']), { repoRoot: f.root });
            assert.deepEqual(result.violations, []);
            assert.deepEqual(result.source_evidence?.map(item => item.case_id), ['one', 'two']);
            assert.equal(result.source_evidence?.[0].source_identity.sha256,
                result.source_evidence?.[1].source_identity.sha256);
        } finally { f.remove(); }
    });

    it('binds case meaning references and source bytes into the retained digest', () => {
        const f = fixture({ 'Source': 'source' });
        try {
            const first = bindSources(matrix(['Source#case']), { repoRoot: f.root });
            const repeated = bindSources(matrix(['Source#case']), { repoRoot: f.root });
            const different = bindSources(matrix(['Source#another-case']), { repoRoot: f.root });
            fs.writeFileSync(path.join(f.root, 'Source'), 'changed source');
            const changed = bindSources(matrix(['Source#case']), { repoRoot: f.root });
            assert.match(first.source_bindings_sha256, /^[a-f0-9]{64}$/u);
            assert.equal(first.source_bindings_sha256, repeated.source_bindings_sha256);
            assert.notEqual(first.source_bindings_sha256, different.source_bindings_sha256);
            assert.notEqual(first.source_bindings_sha256, changed.source_bindings_sha256);
        } finally { f.remove(); }
    });
});
