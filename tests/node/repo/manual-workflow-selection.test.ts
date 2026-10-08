import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as childProcess from 'node:child_process';
import test from 'node:test';
import { getRepoRoot } from '../../../scripts/node-foundation/build';

const selectorPath = path.join(getRepoRoot(), 'scripts/manual-workflow-authorization.cjs');
interface Selection {
    repository: string;
    commit: string;
    complete_matrix_requested: boolean;
    jobs: Record<string, { enabled: boolean; matrix: { include: Array<{ os: string; 'node-version': string }> } }>;
}
const { AUTHORIZATION_PHRASE, selectManualWorkflow } = require(selectorPath) as {
    AUTHORIZATION_PHRASE: string;
    selectManualWorkflow: (env: Record<string, string>) => Selection;
};
const commit = 'a'.repeat(40);
function inputs(overrides: Record<string, string> = {}): Record<string, string> {
    return {
        MANUAL_WORKFLOW: 'ci', GITHUB_EVENT_NAME: 'workflow_dispatch',
        GITHUB_REPOSITORY: 'example/garda', MANUAL_REPOSITORY: 'example/garda',
        GITHUB_SHA: commit, MANUAL_COMMIT: commit, MANUAL_AUTHORIZATION: AUTHORIZATION_PHRASE,
        MANUAL_JOB: 'test-cli', MANUAL_OS: 'ubuntu-latest', MANUAL_RUNTIME: '24', ...overrides
    };
}

function smokeInputs(overrides: Record<string, string> = {}): Record<string, string> {
    return inputs({ MANUAL_WORKFLOW: 'smoke-schedule', MANUAL_JOB: 'smoke', ...overrides });
}

test('manual selector binds one exact repository and SHA to one job OS and runtime', () => {
    const selected = selectManualWorkflow(inputs());
    assert.equal(selected.repository, 'example/garda');
    assert.equal(selected.commit, commit);
    assert.equal(selected.complete_matrix_requested, false);
    assert.deepEqual(Object.entries(selected.jobs).filter(([, job]) => job.enabled).map(([id]) => id), ['test-cli']);
    assert.deepEqual(selected.jobs['test-cli'].matrix.include, [{ os: 'ubuntu-latest', 'node-version': '24' }]);
});

test('manual selector enumerates the complete CI matrix only after explicit all selections', () => {
    const selected = selectManualWorkflow(inputs({ MANUAL_JOB: 'all', MANUAL_OS: 'all', MANUAL_RUNTIME: 'all' }));
    assert.equal(selected.complete_matrix_requested, true);
    assert.equal(Object.values(selected.jobs).flatMap(job => job.matrix.include).length, 22);
    assert.deepEqual(selected.jobs.release.matrix.include.map(row => row.os), ['ubuntu-latest', 'ubuntu-latest', 'windows-latest', 'windows-latest']);
    assert.deepEqual(selected.jobs.smoke.matrix.include.map(row => row.os), ['ubuntu-latest', 'ubuntu-latest', 'windows-latest', 'windows-latest', 'macos-latest', 'macos-latest']);
});

test('manual selector narrows compatible all-job selection to the requested Windows runtime', () => {
    const selected = selectManualWorkflow(inputs({ MANUAL_JOB: 'all', MANUAL_OS: 'windows-latest', MANUAL_RUNTIME: '22.13.0' }));
    assert.deepEqual(Object.entries(selected.jobs).filter(([, job]) => job.enabled).map(([id]) => id), ['release', 'smoke']);
    assert.deepEqual(selected.jobs.release.matrix.include, [{ os: 'windows-latest', 'node-version': '22.13.0' }]);
    assert.equal(selected.complete_matrix_requested, false);
});

test('manual selector rejects missing authorization and automatic or foreign dispatch inputs', () => {
    assert.throws(() => selectManualWorkflow(inputs({ MANUAL_AUTHORIZATION: '' })), /authorization/);
    assert.throws(() => selectManualWorkflow(inputs({ GITHUB_EVENT_NAME: 'push' })), /dispatch/);
    assert.throws(() => selectManualWorkflow(inputs({ GITHUB_EVENT_NAME: 'pull_request' })), /dispatch/);
    assert.throws(() => selectManualWorkflow(inputs({ GITHUB_EVENT_NAME: 'schedule' })), /dispatch/);
    assert.throws(() => selectManualWorkflow(inputs({ MANUAL_REPOSITORY: 'foreign/garda' })), /repository/);
    assert.throws(() => selectManualWorkflow(inputs({ MANUAL_COMMIT: 'b'.repeat(40) })), /SHA/);
    assert.throws(() => selectManualWorkflow(inputs({ GITHUB_SHA: 'abc', MANUAL_COMMIT: 'abc' })), /SHA/);
});

test('manual selector rejects injection, prototype names and unsupported choices', () => {
    assert.throws(() => selectManualWorkflow(inputs({ MANUAL_WORKFLOW: '__proto__' })), /profile/);
    assert.throws(() => selectManualWorkflow(inputs({ MANUAL_JOB: 'toString' })), /job/);
    assert.throws(() => selectManualWorkflow(inputs({ MANUAL_JOB: 'test-cli; echo unsafe' })), /job/);
    assert.throws(() => selectManualWorkflow(inputs({ MANUAL_OS: 'self-hosted' })), /OS/);
    assert.throws(() => selectManualWorkflow(inputs({ MANUAL_RUNTIME: '24\nforged=value' })), /runtime/);
    assert.throws(() => selectManualWorkflow(inputs({ MANUAL_OS: 'windows-latest' })), /support/);
    assert.throws(() => selectManualWorkflow(inputs({ MANUAL_REPOSITORY: 'example/garda\nforged=value' })), /repository/);
});

test('manual selector rejects implicit publication and unsupported auxiliary runtimes', () => {
    const security = selectManualWorkflow(inputs({ MANUAL_WORKFLOW: 'security', MANUAL_JOB: 'osv' }));
    assert.deepEqual(Object.entries(security.jobs).filter(([, job]) => job.enabled).map(([id]) => id), ['osv']);
    const smoke = selectManualWorkflow(inputs({ MANUAL_WORKFLOW: 'smoke-schedule', MANUAL_JOB: 'smoke', MANUAL_OS: 'macos-latest' }));
    assert.deepEqual(smoke.jobs.smoke.matrix.include, [{ os: 'macos-latest', 'node-version': '24' }]);
    const secrets = selectManualWorkflow(inputs({ MANUAL_WORKFLOW: 'secret-scanning', MANUAL_JOB: 'gitleaks' }));
    assert.equal(secrets.jobs.gitleaks.matrix.include.length, 1);
    const sbom = selectManualWorkflow(inputs({ MANUAL_WORKFLOW: 'sbom', MANUAL_JOB: 'sbom' }));
    assert.equal(sbom.jobs.sbom.matrix.include.length, 1);
    assert.throws(() => selectManualWorkflow(inputs({ MANUAL_WORKFLOW: 'publish', MANUAL_JOB: 'all' })), /explicit operation/);
    const validate = selectManualWorkflow(inputs({ MANUAL_WORKFLOW: 'publish', MANUAL_JOB: 'validate' }));
    assert.equal(validate.jobs['stage-publish'].enabled, false);
    const stage = selectManualWorkflow(inputs({ MANUAL_WORKFLOW: 'publish', MANUAL_JOB: 'stage-publish' }));
    assert.equal(stage.jobs.validate.enabled, true);
    assert.equal(stage.jobs['stage-publish'].enabled, true);
    assert.equal(stage.complete_matrix_requested, false);
    assert.throws(() => selectManualWorkflow(inputs({ MANUAL_WORKFLOW: 'security', MANUAL_JOB: 'osv', MANUAL_RUNTIME: '22.13.0' })), /runtime/);
});

test('manual selector CLI emits one JSON output record and rejects malformed inputs before writing', () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-manual-selection-'));
    try {
        const output = path.join(temp, 'output');
        fs.writeFileSync(output, 'existing=value\n');
        const run = (overrides: Record<string, string>) => childProcess.spawnSync(process.execPath, [selectorPath], {
            env: { ...process.env, ...inputs(overrides), GITHUB_OUTPUT: output }, encoding: 'utf8', timeout: 10000
        });
        const accepted = run({});
        assert.equal(accepted.error, undefined);
        assert.equal(accepted.status, 0, accepted.stderr);
        const records = fs.readFileSync(output, 'utf8').trimEnd().split('\n');
        assert.equal(records.length, 2);
        assert.equal(records[0], 'existing=value');
        assert.equal(JSON.parse(records[1].slice('selection='.length)).commit, commit);
        const before = fs.readFileSync(output);
        const rejected = run({ MANUAL_JOB: 'test-cli\nforged=value' });
        assert.equal(rejected.status, 1);
        assert.match(rejected.stderr, /MANUAL_SELECTION_REJECTED/);
        assert.deepEqual(fs.readFileSync(output), before);
    } finally {
        fs.rmSync(temp, { recursive: true, force: true });
    }
});

test('manual smoke dispatch binds authorization and selected matrix to the exact run SHA', () => {
    const workflow = fs.readFileSync(path.join(getRepoRoot(), '.github/workflows/smoke-schedule.yml'), 'utf8');
    assert.doesNotMatch(workflow, /^ {2}(push|pull_request|schedule|workflow_call):/mu);
    assert.match(workflow, /^ {2}workflow_dispatch:\n {4}inputs:/mu);
    assert.match(workflow, /^ {2}contents: read$/mu);
    assert.doesNotMatch(workflow, /contents: write|id-token: write|secrets: inherit|continue-on-error/u);
    assert.ok(workflow.includes('group: ${{ github.workflow }}-${{ github.run_id }}'));
    assert.match(workflow, /^ {2}cancel-in-progress: false$/mu);
    for (const input of ['repository', 'commit', 'authorization']) {
        const block = workflow.match(new RegExp('^ {6}' + input + ':\\n([\\s\\S]*?)(?=^ {6}[a-z]+:)', 'mu'))?.[1];
        assert.ok(block, input);
        assert.match(block, /^ {8}required: true$/mu);
        assert.match(block, /^ {8}type: string$/mu);
        assert.doesNotMatch(block, /^ {8}default:/mu);
    }
    for (const [input, defaultValue, options] of [
        ['job', 'smoke', '[smoke, all]'],
        ['os', 'ubuntu-latest', '[ubuntu-latest, windows-latest, macos-latest, all]'],
        ['runtime', "'24'", "['22.13.0', '24', all]"]
    ]) {
        const block = workflow.match(new RegExp('^ {6}' + input + ':\\n([\\s\\S]*?)(?=^ {6}[a-z]+:|^concurrency:)', 'mu'))?.[1];
        assert.ok(block, input);
        assert.match(block, /^ {8}required: true$/mu);
        assert.match(block, /^ {8}type: choice$/mu);
        assert.ok(block.includes('        default: ' + defaultValue + '\n'));
        assert.ok(block.includes('        options: ' + options + '\n'));
    }
    const jobs = workflow.slice(workflow.indexOf('\njobs:\n')).split(/\n(?= {2}[a-z][a-z-]*:\n)/u);
    const authorize = jobs.find(job => job.startsWith('  authorize:'));
    const smoke = jobs.find(job => job.startsWith('  smoke:'));
    assert.ok(authorize);
    assert.ok(smoke);
    assert.match(authorize, /^ {4}runs-on: ubuntu-latest$/mu);
    assert.ok(authorize.includes("node-version: '24'"));
    assert.ok(authorize.includes('selection: ${{ steps.selection.outputs.selection }}'));
    assert.ok(authorize.includes('MANUAL_WORKFLOW: smoke-schedule'));
    for (const [name, input] of Object.entries({ REPOSITORY: 'repository', COMMIT: 'commit',
        AUTHORIZATION: 'authorization', JOB: 'job', OS: 'os', RUNTIME: 'runtime' })) {
        assert.ok(authorize.includes('MANUAL_' + name + ': ${{ inputs.' + input + ' }}'));
    }
    assert.match(authorize, /^ {8}run: node scripts\/manual-workflow-authorization\.cjs$/mu);
    assert.doesNotMatch(workflow, /run:.*\$\{\{ inputs\./u);
    assert.match(smoke, /^ {4}needs: \[authorize\]$/mu);
    assert.match(smoke, /^ {4}if: \$\{\{ !cancelled\(\) && needs\.authorize\.result == 'success' && fromJSON\(needs\.authorize\.outputs\.selection\)\.jobs\['smoke'\]\.enabled \}\}$/mu);
    assert.match(smoke, /^ {4}runs-on: \$\{\{ matrix\.os \}\}$/mu);
    assert.match(smoke, /^ {6}fail-fast: false$/mu);
    assert.ok(smoke.includes("matrix: ${{ fromJSON(needs.authorize.outputs.selection).jobs['smoke'].matrix }}"));
    for (const job of [authorize, smoke]) {
        assert.ok(job.includes('actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7.0.0'));
        assert.ok(job.includes('ref: ${{ github.sha }}'));
        assert.ok(job.includes('persist-credentials: false'));
        assert.ok(job.includes('actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38 # v6.5.0'));
    }
    assert.match(smoke, /^ {10}node-version: \$\{\{ matrix\.node-version \}\}$/mu);
});

test('manual smoke selection preserves bounded coverage and narrow defaults', () => {
    const narrow = selectManualWorkflow(smokeInputs());
    assert.deepEqual(narrow.jobs.smoke, { enabled: true, matrix: { include: [{ os: 'ubuntu-latest', 'node-version': '24' }] } });
    assert.equal(narrow.complete_matrix_requested, false);
    const full = selectManualWorkflow(smokeInputs({
        MANUAL_JOB: 'all', MANUAL_OS: 'all', MANUAL_RUNTIME: 'all'
    }));
    assert.equal(full.complete_matrix_requested, true);
    assert.deepEqual(full.jobs.smoke.matrix.include, [
        { os: 'ubuntu-latest', 'node-version': '22.13.0' }, { os: 'ubuntu-latest', 'node-version': '24' },
        { os: 'windows-latest', 'node-version': '22.13.0' }, { os: 'windows-latest', 'node-version': '24' },
        { os: 'macos-latest', 'node-version': '22.13.0' }, { os: 'macos-latest', 'node-version': '24' }
    ]);
    const partial = selectManualWorkflow(smokeInputs({
        MANUAL_JOB: 'all', MANUAL_OS: 'windows-latest', MANUAL_RUNTIME: '22.13.0'
    }));
    assert.deepEqual(partial.jobs.smoke.matrix.include, [{ os: 'windows-latest', 'node-version': '22.13.0' }]);
    assert.equal(partial.complete_matrix_requested, false);
});

test('manual smoke selection rejects missing foreign and forged authority or unsupported choices', () => {
    assert.throws(() => selectManualWorkflow(smokeInputs({ MANUAL_AUTHORIZATION: '' })), /authorization/);
    assert.throws(() => selectManualWorkflow(smokeInputs({ MANUAL_REPOSITORY: 'foreign/garda' })), /repository/);
    assert.throws(() => selectManualWorkflow(smokeInputs({ MANUAL_COMMIT: 'b'.repeat(40) })), /SHA/);
    assert.throws(() => selectManualWorkflow(smokeInputs({ GITHUB_EVENT_NAME: 'schedule' })), /dispatch/);
    assert.throws(() => selectManualWorkflow(smokeInputs({ GITHUB_EVENT_NAME: 'push' })), /dispatch/);
    assert.throws(() => selectManualWorkflow(smokeInputs({ MANUAL_OS: 'self-hosted' })), /OS/);
    assert.throws(() => selectManualWorkflow(smokeInputs({ MANUAL_RUNTIME: '20' })), /runtime/);
    assert.throws(() => selectManualWorkflow(smokeInputs({ MANUAL_JOB: 'smoke; echo unsafe' })), /job/);
    assert.throws(() => selectManualWorkflow(smokeInputs({ MANUAL_RUNTIME: '24\nforged=value' })), /runtime/);
});

for (const [profile, jobId, label] of [
    ['secret-scanning', 'gitleaks', 'Secret Scanning'],
    ['sbom', 'sbom', 'SBOM']
] as const) {
    test(profile + ' dispatch binds explicit authorization and selected scan to the immutable run commit', () => {
        const workflow = fs.readFileSync(path.join(getRepoRoot(), '.github/workflows', profile + '.yml'), 'utf8');
        assert.doesNotMatch(workflow, /^ {2}(push|pull_request|schedule|workflow_call):/mu);
        assert.match(workflow, /^ {2}workflow_dispatch:\n {4}inputs:/mu);
        assert.match(workflow, /^ {2}contents: read$/mu);
        assert.doesNotMatch(workflow, /contents: write|id-token: write|security-events: write|secrets: inherit|continue-on-error/u);
        assert.ok(workflow.includes('group: ${{ github.workflow }}-${{ github.run_id }}'));
        assert.match(workflow, /^ {2}cancel-in-progress: false$/mu);
        for (const input of ['repository', 'commit', 'authorization']) {
            const block = workflow.match(new RegExp('^ {6}' + input + ':\\n([\\s\\S]*?)(?=^ {6}[a-z]+:)', 'mu'))?.[1];
            assert.ok(block, input);
            assert.match(block, /^ {8}required: true$/mu);
            assert.match(block, /^ {8}type: string$/mu);
            assert.doesNotMatch(block, /^ {8}default:/mu);
        }
        const jobs = workflow.slice(workflow.indexOf('\njobs:\n'))
            .split(/\n(?= {2}[a-z][a-z-]*:\n)/u);
        const authorize = jobs.find(value => value.startsWith('  authorize:'));
        const scanner = jobs.find(value => value.startsWith('  ' + jobId + ':'));
        assert.ok(authorize);
        assert.ok(scanner);
        assert.ok(authorize.includes('name: Authorize ' + label + ' selection'));
        assert.ok(authorize.includes('selection: ${{ steps.selection.outputs.selection }}'));
        assert.ok(authorize.includes('MANUAL_WORKFLOW: ' + profile));
        for (const [name, input] of Object.entries({
            REPOSITORY: 'repository', COMMIT: 'commit', AUTHORIZATION: 'authorization',
            JOB: 'job', OS: 'os', RUNTIME: 'runtime'
        })) {
            assert.ok(authorize.includes('MANUAL_' + name + ': ${{ inputs.' + input + ' }}'));
        }
        assert.match(authorize, /run: node scripts\/manual-workflow-authorization\.cjs$/mu);
        assert.doesNotMatch(authorize, /run:.*\$\{\{ inputs\./u);
        assert.match(scanner, /^ {4}needs: \[authorize\]$/mu);
        assert.ok(scanner.includes("needs.authorize.result == 'success'"));
        assert.ok(scanner.includes('!cancelled()'));
        assert.ok(scanner.includes("jobs['" + jobId + "'].enabled"));
        for (const job of [authorize, scanner]) {
            assert.ok(job.includes('actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7.0.0'));
            assert.ok(job.includes('ref: ${{ github.sha }}'));
            assert.ok(job.includes('persist-credentials: false'));
        }
        assert.ok(authorize.includes('actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38 # v6.5.0'));
        assert.ok(authorize.includes("node-version: '24'"));
        if (profile === 'secret-scanning') {
            assert.ok(scanner.includes('fetch-depth: 0'));
            assert.ok(scanner.includes("GITLEAKS_VERSION: '8.30.1'"));
            assert.ok(scanner.includes("GITLEAKS_SHA256: '551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb'"));
            assert.ok(scanner.includes('sha256sum --check --strict'));
            assert.ok(scanner.includes('gitleaks git --config .gitleaks.toml --redact --exit-code 1 .'));
        } else {
            assert.ok(scanner.includes('run: npm ci --ignore-scripts --no-fund --no-audit'));
            assert.ok(scanner.includes('run: npm run sbom:generate'));
            assert.ok(scanner.includes('Record SBOM toolchain identity'));
            assert.ok(scanner.includes('actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1'));
            assert.ok(scanner.includes('if-no-files-found: error'));
        }
        const selected = selectManualWorkflow(inputs({ MANUAL_WORKFLOW: profile, MANUAL_JOB: jobId }));
        assert.deepEqual(selected.jobs[jobId], {
            enabled: true, matrix: { include: [{ os: 'ubuntu-latest', 'node-version': '24' }] }
        });
        const all = selectManualWorkflow(inputs({
            MANUAL_WORKFLOW: profile, MANUAL_JOB: 'all', MANUAL_OS: 'all', MANUAL_RUNTIME: 'all'
        }));
        assert.deepEqual(all.jobs[jobId].matrix.include, selected.jobs[jobId].matrix.include);
        assert.throws(() => selectManualWorkflow(inputs({
            MANUAL_WORKFLOW: profile, MANUAL_JOB: jobId, MANUAL_AUTHORIZATION: ''
        })), /authorization/);
        assert.throws(() => selectManualWorkflow(inputs({
            MANUAL_WORKFLOW: profile, MANUAL_JOB: jobId, MANUAL_COMMIT: 'b'.repeat(40)
        })), /SHA/);
        assert.throws(() => selectManualWorkflow(inputs({
            MANUAL_WORKFLOW: profile, MANUAL_JOB: jobId, MANUAL_REPOSITORY: 'foreign/garda'
        })), /repository/);
        assert.throws(() => selectManualWorkflow(inputs({
            MANUAL_WORKFLOW: profile, MANUAL_JOB: jobId, MANUAL_OS: 'macos-latest'
        })), /OS/);
        assert.throws(() => selectManualWorkflow(inputs({
            MANUAL_WORKFLOW: profile, MANUAL_JOB: jobId, MANUAL_RUNTIME: '22.13.0'
        })), /runtime/);
    });
}

test('CI dispatch binds authorization data and every selected matrix to the exact runner SHA', () => {
    const workflow = fs.readFileSync(path.join(getRepoRoot(), '.github/workflows/ci.yml'), 'utf8');
    assert.doesNotMatch(workflow, /^ {2}(push|pull_request|schedule|workflow_call):/mu);
    assert.match(workflow, /^ {2}workflow_dispatch:\n {4}inputs:/mu);
    assert.match(workflow, /^ {2}contents: read$/mu);
    const jobs = workflow.slice(workflow.indexOf('\njobs:\n')).split(/\n(?= {2}[a-z][a-z-]*:\n)/u);
    const authorization = jobs.find(job => job.startsWith('  authorize:'));
    assert.ok(authorization);
    assert.match(authorization, /name: Authorize CI selection/u);
    assert.ok(authorization.includes('selection: ${{ steps.selection.outputs.selection }}'));
    for (const [name, input] of Object.entries({ REPOSITORY: 'repository', COMMIT: 'commit',
        AUTHORIZATION: 'authorization', JOB: 'job', OS: 'os', RUNTIME: 'runtime' })) {
        assert.ok(authorization.includes('MANUAL_' + name + ': ${{ inputs.' + input + ' }}'));
    }
    assert.match(authorization, /MANUAL_WORKFLOW: ci/u);
    assert.match(authorization, /run: node scripts\/manual-workflow-authorization\.cjs/u);
    assert.doesNotMatch(authorization, /run:.*\$\{\{ inputs\./u);
    const identifiers = ['typecheck', 'test-unit', 'test-gates', 'test-cli', 'test-lifecycle', 'test-bin', 'validate-release', 'smoke'];
    for (const id of identifiers) {
        const job = jobs.find(value => value.startsWith('  ' + id + ':'));
        assert.ok(job, id);
        const logical = id === 'validate-release' ? 'release' : id;
        assert.ok(job.includes("needs.authorize.result == 'success'"));
        assert.ok(job.includes('!cancelled()'));
        assert.ok(job.includes("jobs['" + logical + "'].enabled"));
        assert.ok(job.includes("!contains(needs.*.result, 'failure')"));
        assert.ok(job.includes("!contains(needs.*.result, 'cancelled')"));
        assert.ok(job.includes("matrix: ${{ fromJSON(needs.authorize.outputs.selection).jobs['" + logical + "'].matrix }}"));
        assert.match(job, /^ {4}needs: \[authorize(?:, [a-z-]+)*\]$/mu);
        assert.match(job, /^ {4}if: \$\{\{ always\(\)/mu);
        assert.ok(job.includes('          ref: ${{ github.sha }}'));
    }
    assert.equal(workflow.split('ref: ${{ github.sha }}').length - 1, 9);
    assert.doesNotMatch(workflow, /secrets: inherit|contents: write|id-token: write/u);
});

test('CI release dependency graph rejects selected static failure and cancellation while preserving standalone release', () => {
    const workflow = fs.readFileSync(path.join(getRepoRoot(), '.github/workflows/ci.yml'), 'utf8');
    const release = workflow.match(/^ {2}validate-release:\n([\s\S]*?)(?=^ {4}steps:)/mu)?.[1];
    assert.ok(release);
    const needs = release.match(/^ {4}needs: \[([^\]]+)\]$/mu)?.[1];
    assert.ok(needs);
    const dependencies = needs.split(',').map(value => value.trim());
    assert.match(release, /!contains\(needs\.\*\.result, 'failure'\)/u);
    assert.match(release, /!contains\(needs\.\*\.result, 'cancelled'\)/u);
    const tests = ['test-unit', 'test-gates', 'test-cli', 'test-lifecycle', 'test-bin'];
    const results: Record<string, string> = {
        authorize: 'success', typecheck: 'failure', ...Object.fromEntries(tests.map(id => [id, 'skipped']))
    };
    const visibleResults = () => dependencies.map(id => {
        assert.ok(Object.hasOwn(results, id), 'Unexpected release prerequisite: ' + id);
        return results[id];
    });
    // needs.* exposes direct dependencies only: the five skipped test families
    // cannot carry their failed static-check ancestor into the release condition.
    assert.ok(visibleResults().includes('failure'), 'A selected static failure must reach the release failure guard');
    results.typecheck = 'cancelled';
    assert.ok(visibleResults().includes('cancelled'), 'A selected static cancellation must reach the release cancellation guard');
    results.typecheck = 'skipped';
    assert.ok(visibleResults().every(result => result === 'success' || result === 'skipped'),
        'Standalone release must retain intentionally unselected prerequisites');
    results.typecheck = 'success';
    for (const id of tests) results[id] = 'success';
    assert.ok(visibleResults().every(result => result === 'success'), 'A complete successful suite must remain eligible');
    for (const id of tests) {
        results[id] = 'failure';
        assert.ok(visibleResults().includes('failure'), 'Selected test failure must remain visible: ' + id);
        results[id] = 'success';
    }
});
