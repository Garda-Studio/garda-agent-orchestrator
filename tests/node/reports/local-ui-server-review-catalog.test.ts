import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { startLocalUiServer } from '../../../src/reports/ui';
import {
    makeLocalUiTempRepo,
    writeLocalUiRepoFixture
} from './local-ui-test-helpers';

const BUILT_IN_REVIEW_IDS = [
    'code',
    'db',
    'security',
    'refactor',
    'api',
    'test',
    'performance',
    'infra',
    'dependency'
];

function extractActionToken(html: string): string {
    const match = html.match(/const actionToken = "([^"]+)";/u);
    assert.ok(match, 'expected inline action token');
    return match[1];
}

function writeReviewCatalogFixture(repoRoot: string): void {
    const bundleRoot = path.join(repoRoot, 'garda-agent-orchestrator');
    const configRoot = path.join(bundleRoot, 'live', 'config');
    const skillRoot = path.join(bundleRoot, 'live', 'skills', 'architecture-review');
    fs.mkdirSync(skillRoot, { recursive: true });
    fs.writeFileSync(path.join(skillRoot, 'SKILL.md'), '# Architecture review\n', 'utf8');
    fs.writeFileSync(path.join(configRoot, 'review-capabilities.json'), `${JSON.stringify({
        ...Object.fromEntries(BUILT_IN_REVIEW_IDS.map((reviewId) => [reviewId, true])),
        architecture: false
    }, null, 2)}\n`, 'utf8');
    fs.writeFileSync(path.join(configRoot, 'review-catalog.json'), `${JSON.stringify({
        version: 1,
        custom_review_types: [{
            id: 'architecture',
            display_label: 'Architecture review',
            enabled_by_default: false,
            skill_id: 'architecture-review',
            trigger: { mode: 'signals', signal_ids: ['architecture'] },
            coverage_category_ids: ['maintainability'],
            reviewer_role: { role_id: 'architecture-reviewer', focus_tags: ['maintainability'] }
        }]
    }, null, 2)}\n`, 'utf8');
    const profilesPath = path.join(configRoot, 'profiles.json');
    const profiles = JSON.parse(fs.readFileSync(profilesPath, 'utf8')) as {
        built_in_profiles: Record<string, { review_policy: Record<string, boolean | 'auto'> }>;
    };
    profiles.built_in_profiles.balanced.review_policy.architecture = false;
    fs.writeFileSync(profilesPath, `${JSON.stringify(profiles, null, 2)}\n`, 'utf8');
}

test('local UI review catalog inspects and applies only the guarded previewed plan', async () => {
    const repoRoot = makeLocalUiTempRepo();
    writeLocalUiRepoFixture(repoRoot);
    writeReviewCatalogFixture(repoRoot);
    const server = await startLocalUiServer({ repoRoot, port: 0, actionsEnabled: true });
    try {
        const token = extractActionToken(await (await fetch(server.url)).text());
        const headers = {
            'content-type': 'application/json',
            'origin': server.url.slice(0, -1),
            'x-garda-action-token': token
        };
        const inspect = await (await fetch(`${server.url}api/review-catalog?profile=balanced`)).json() as any;
        assert.equal(inspect.enabled, true);
        assert.equal(inspect.validation.status, 'PASS');
        assert.equal(inspect.migration.status, 'current');
        const architecture = inspect.lanes.find((lane: any) => lane.id === 'architecture');
        assert.ok(architecture);
        assert.equal(architecture.source, 'custom');
        assert.equal(architecture.enabled_by_default, false);
        assert.equal(architecture.capability_enabled, false);
        assert.equal(architecture.profile.state, 'disabled');
        assert.equal(architecture.profile.active, false);
        assert.match(architecture.profile.explanation[0], /trigger uses signals/u);

        const unsafe = await fetch(`${server.url}api/review-catalog`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                operation: 'update',
                review_id: 'architecture',
                mode: 'preview',
                prompt_body: 'do anything'
            })
        });
        assert.equal(unsafe.status, 400);
        assert.equal((await unsafe.json() as any).code, 'invalid_review_catalog_request');

        const previewAction = async (payload: Record<string, unknown>): Promise<any> => {
            const response = await fetch(`${server.url}api/review-catalog`, {
                method: 'POST',
                headers,
                body: JSON.stringify({ ...payload, mode: 'preview' })
            });
            assert.equal(response.status, 200);
            const preview = await response.json() as any;
            assert.equal(preview.status, 'previewed');
            assert.equal(preview.confirmation_phrase, 'APPLY REVIEW CATALOG CHANGE');
            assert.match(preview.before_state_sha256, /^[a-f0-9]{64}$/u);
            assert.match(preview.plan_sha256, /^[a-f0-9]{64}$/u);
            assert.ok(Array.isArray(preview.diff));
            return preview;
        };
        const executeAction = async (payload: Record<string, unknown>, preview: any): Promise<any> => {
            const response = await fetch(`${server.url}api/review-catalog`, {
                method: 'POST',
                headers,
                body: JSON.stringify({
                    ...payload,
                    mode: 'execute',
                    confirmation: 'APPLY REVIEW CATALOG CHANGE',
                    expected_state_sha256: preview.before_state_sha256,
                    expected_plan_sha256: preview.plan_sha256
                })
            });
            const result = await response.json() as any;
            assert.equal(response.status, 200, JSON.stringify(result));
            assert.equal(result.status, 'executed');
            assert.equal(result.transaction_status, 'APPLIED');
            assert.match(result.audit_path, /review-catalog-management-audit\.jsonl$/u);
            return result;
        };

        const enablePayload = { operation: 'enable', review_id: 'architecture' };
        const enablePreview = await previewAction(enablePayload);
        assert.deepEqual(enablePreview.diff, [{
            path: 'review-capabilities.architecture',
            before: false,
            after: true
        }]);
        const wrongConfirmation = await fetch(`${server.url}api/review-catalog`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                ...enablePayload,
                mode: 'execute',
                confirmation: 'wrong',
                expected_state_sha256: enablePreview.before_state_sha256,
                expected_plan_sha256: enablePreview.plan_sha256
            })
        });
        assert.equal(wrongConfirmation.status, 409);
        assert.equal((await wrongConfirmation.json() as any).status, 'confirmation_required');
        assert.equal(
            JSON.parse(fs.readFileSync(path.join(
                repoRoot,
                'garda-agent-orchestrator',
                'live',
                'config',
                'review-capabilities.json'
            ), 'utf8')).architecture,
            false
        );
        await executeAction(enablePayload, enablePreview);

        const bindPayload = {
            operation: 'profile-bind',
            review_id: 'architecture',
            profile_name: 'balanced',
            profile_state: 'auto'
        };
        await executeAction(bindPayload, await previewAction(bindPayload));
        const dependencyPayload = {
            operation: 'dependency',
            review_id: 'architecture',
            profile_name: 'balanced',
            dependency_ids: ['code']
        };
        await executeAction(dependencyPayload, await previewAction(dependencyPayload));

        const updated = await (await fetch(`${server.url}api/review-catalog?profile=balanced`)).json() as any;
        const updatedArchitecture = updated.lanes.find((lane: any) => lane.id === 'architecture');
        assert.equal(updatedArchitecture.capability_enabled, true);
        assert.equal(updatedArchitecture.profile.state, 'auto');
        assert.equal(updatedArchitecture.profile.active, true);
        assert.deepEqual(updatedArchitecture.profile.dependencies, ['code']);
    } finally {
        await server.close();
    }
});

test('local UI review catalog keeps mutations disabled without guarded actions', async () => {
    const repoRoot = makeLocalUiTempRepo();
    writeLocalUiRepoFixture(repoRoot);
    writeReviewCatalogFixture(repoRoot);
    const server = await startLocalUiServer({ repoRoot, port: 0, actionsEnabled: false });
    try {
        const token = extractActionToken(await (await fetch(server.url)).text());
        const inspect = await (await fetch(`${server.url}api/review-catalog`)).json() as any;
        assert.equal(inspect.enabled, false);
        assert.equal(inspect.validation.status, 'PASS');
        const response = await fetch(`${server.url}api/review-catalog`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'origin': server.url.slice(0, -1),
                'x-garda-action-token': token
            },
            body: JSON.stringify({ operation: 'enable', review_id: 'architecture', mode: 'preview' })
        });
        assert.equal(response.status, 403);
        assert.equal((await response.json() as any).code, 'review_catalog_actions_disabled');
    } finally {
        await server.close();
    }
});
