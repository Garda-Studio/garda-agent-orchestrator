import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type * as childProcess from 'node:child_process';
import test from 'node:test';
import { getRepoRoot } from '../../../scripts/node-foundation/build';

interface HistoryRequest {
    repository: string; commit: string; tag: string;
    runId: string | number; runAttempt: string | number; phase: string;
}
interface Proof {
    run_id: number; run_attempt: number; total_attempts: number;
    prior_run_ids: number[]; phase: string; commit: string; tag: string;
}
interface Step {
    name: string; number: number; status: string; conclusion: string | null;
    started_at: string | null; completed_at: string | null;
}
interface Job {
    id: number; run_id: number; run_attempt: number; head_sha: string;
    name: string; status: string; conclusion: string | null;
    started_at: string | null; completed_at: string | null; steps: Step[];
}
interface Run {
    id: number; run_attempt: number; workflow_id: number; head_sha: string;
    head_branch: string; event: string; path: string; status: string;
    conclusion: string | null; repository: { full_name: string };
    head_repository: { full_name: string }; run_started_at: string; updated_at: string;
}
type Fetch = (endpoint: string) => unknown;
const script = path.join(getRepoRoot(), 'scripts/release-publish-history-evidence.cjs');
const { verifyPublishHistory } = require(script) as {
    verifyPublishHistory: (request: HistoryRequest, dependencies?: {
        root?: string; now?: Date; fetch?: Fetch;
    }) => Proof;
};
const repository = 'example/garda';
const commit = 'a'.repeat(40);
const tag = 'v1.4.4';
const base = 'repos/' + repository;
const now = new Date('2026-10-07T12:00:00Z');
const sourceFiles = ['.github/workflows/publish.yml', 'scripts/manual-workflow-authorization.cjs'];

function run(id = 42, attempt = 1, current = true): Run {
    const earlier = new Date(Date.parse('2026-10-07T11:00:00Z') - Math.max(0, 41 - id) * 30 * 60 * 1000);
    return {
        id, run_attempt: attempt, workflow_id: 7, head_sha: commit,
        head_branch: tag, event: 'workflow_dispatch', path: '.github/workflows/publish.yml',
        status: current ? 'in_progress' : 'completed', conclusion: current ? null : 'failure',
        repository: { full_name: repository }, head_repository: { full_name: repository },
        run_started_at: current ? '2026-10-07T11:50:00Z' : earlier.toISOString(),
        updated_at: current ? '2026-10-07T11:55:00Z' : new Date(earlier.getTime() + 10 * 60 * 1000).toISOString()
    };
}

function jobs(metadata: Run, phase = 'validate'): Job[] {
    const current = metadata.status === 'in_progress';
    const at = (minutes: number) => new Date(Date.parse(metadata.run_started_at) + minutes * 60 * 1000).toISOString();
    const make = (name: string, index: number, status: string, conclusion: string | null, steps: Step[]): Job => ({
        id: metadata.id * 100 + metadata.run_attempt * 10 + index,
        run_id: metadata.id, run_attempt: metadata.run_attempt, head_sha: commit,
        name, status, conclusion, started_at: at(index === 1 ? 0 : index === 2 ? 2 : 4),
        completed_at: status === 'completed' ? at(index === 1 ? 1 : index === 2 ? 3 : 4) : null, steps
    });
    const step = (name: string, number = 1, minute = 0): Step => ({
        name, number, status: 'completed', conclusion: 'success',
        started_at: at(minute), completed_at: at(minute + 1)
    });
    const authorize = make('Authorize publish selection', 1, 'completed', 'success', [step('Authorize selected jobs')]);
    const validate = make('Validate release package', 2, current && phase === 'validate' ? 'in_progress' : 'completed',
        current ? phase === 'validate' ? null : 'success' : 'failure', current && phase === 'validate' ? [{
            name: 'Check publication history before validation', number: 1,
            status: 'in_progress', conclusion: null, started_at: at(2), completed_at: null
        }] : current ? ['Validate tag and package version', 'Require successful CI for this release commit',
            'Run local release proof', 'Pack and attest release candidate'].map((name, index) => step(name, index + 1, 2)) : []);
    const stage = make('Stage package on npm', 3, current && phase === 'stage-publish' ? 'in_progress' : 'completed',
        current && phase === 'stage-publish' ? null : 'skipped', current && phase === 'stage-publish' ? [{
            name: 'Check publication history before staging', number: 1,
            status: 'in_progress', conclusion: null, started_at: at(4), completed_at: null
        }, {
            name: 'Stage the validated tarball with npm Trusted Publishing', number: 2,
            status: 'queued', conclusion: null, started_at: null, completed_at: null
        }] : []);
    return [authorize, validate, stage];
}

function fixture(phase = 'validate') {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-publish-history-'));
    for (const relative of sourceFiles) {
        fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
        fs.copyFileSync(path.join(getRepoRoot(), relative), path.join(root, relative));
    }
    // Synthetic proposed manual Publish jobs exercise the unwired guard; this is not hosted proof.
    const current = run();
    const currentJobs = jobs(current, phase);
    const runs = [current];
    const payloads = new Map<string, unknown>([
        [base + '/actions/workflows/publish.yml', { id: 7, path: '.github/workflows/publish.yml', state: 'active' }],
        [base + '/git/ref/tags/' + tag, { ref: 'refs/tags/' + tag, object: { type: 'commit', sha: commit } }],
        [base + '/actions/runs/42', current],
        [base + '/actions/runs/42/attempts/1', current],
        [base + '/actions/workflows/publish.yml/runs?branch=' + tag + '&per_page=100&page=1', { total_count: 1, workflow_runs: runs }],
        [base + '/actions/runs/42/jobs?filter=all&per_page=100&page=1', { total_count: 3, jobs: currentJobs }]
    ]);
    for (const relative of sourceFiles) {
        const bytes = fs.readFileSync(path.join(root, relative));
        payloads.set(base + '/contents/' + relative + '?ref=' + commit, {
            type: 'file', path: relative, encoding: 'base64', size: bytes.length, content: bytes.toString('base64')
        });
    }
    const calls: string[] = [];
    const fetch: Fetch = endpoint => {
        calls.push(endpoint);
        if (!payloads.has(endpoint)) throw new Error('Unmocked authenticated endpoint: ' + endpoint);
        return payloads.get(endpoint);
    };
    const request: HistoryRequest = { repository, commit, tag, runId: '42', runAttempt: '1', phase };
    const verify = () => verifyPublishHistory(request, { root, now, fetch });
    const dispose = () => fs.rmSync(root, { recursive: true, force: true });
    const addPrior = (metadata = run(41, 1, false), history = jobs(metadata)) => {
        runs.push(metadata);
        payloads.set(base + '/actions/runs/' + metadata.id, metadata);
        payloads.set(base + '/actions/runs/' + metadata.id + '/attempts/' + metadata.run_attempt, metadata);
        payloads.set(base + '/actions/runs/' + metadata.id + '/jobs?filter=all&per_page=100&page=1', { total_count: history.length, jobs: history });
        payloads.set(base + '/actions/workflows/publish.yml/runs?branch=' + tag + '&per_page=100&page=1', { total_count: runs.length, workflow_runs: runs });
        return { metadata, history };
    };
    return { root, current, currentJobs, runs, payloads, calls, request, verify, dispose, addPrior, fetch };
}

test('offline publish guard accepts initial validation and known pre-stage failure within a shared tag budget', () => {
    const f = fixture();
    try {
        assert.equal(f.verify().total_attempts, 1);
        f.addPrior();
        assert.deepEqual(f.verify().prior_run_ids, [41]);
        assert.equal(f.verify().total_attempts, 2);
        assert.equal(f.verify().commit, commit);
    } finally { f.dispose(); }
});

test('offline publish guard accepts retained authorization only with authenticated complete attempt history', () => {
    const f = fixture();
    try {
        const previous = run(42, 1, false);
        const oldJobs = jobs(previous);
        f.current.run_attempt = 2;
        f.request.runAttempt = '2';
        const latest = jobs(f.current)[1];
        f.payloads.set(base + '/actions/runs/42/attempts/1', previous);
        f.payloads.set(base + '/actions/runs/42/attempts/2', f.current);
        f.payloads.set(base + '/actions/runs/42/jobs?filter=all&per_page=100&page=1', { total_count: 4, jobs: [...oldJobs, latest] });
        assert.equal(f.verify().total_attempts, 2);
        assert.ok(f.calls.includes(base + '/actions/runs/42/attempts/1'));
    } finally { f.dispose(); }
});

test('offline publish guard rejects started npm step after accepting validated pre-stage state', () => {
    const f = fixture('stage-publish');
    try {
        assert.equal(f.verify().phase, 'stage-publish');
        f.currentJobs[2].steps[1].status = 'in_progress';
        f.currentJobs[2].steps[1].started_at = '2026-10-07T11:54:00Z';
        assert.throws(f.verify, /stage|staging/i);
    } finally { f.dispose(); }
});

test('publish guard rejects failed incomplete or missing validation proof before staging', () => {
    const f = fixture('stage-publish');
    try {
        const validation = f.currentJobs[1];
        assert.equal(f.verify().phase, 'stage-publish');
        validation.conclusion = 'failure';
        assert.throws(f.verify, /staging lacks successful validation/i);
        validation.conclusion = 'success';
        const completedAt = validation.completed_at;
        Object.assign(validation, { status: 'in_progress', conclusion: null, completed_at: null });
        assert.throws(f.verify, /staging lacks successful validation/i);
        Object.assign(validation, { status: 'completed', conclusion: 'success', completed_at: completedAt });
        const requiredNames = ['Validate tag and package version', 'Require successful CI for this release commit',
            'Run local release proof', 'Pack and attest release candidate'];
        for (const name of requiredNames) {
            const steps = validation.steps;
            validation.steps = steps.filter(step => step.name !== name);
            assert.throws(f.verify, /required.*step is missing or replaced/i);
            validation.steps = steps;
            const proofStep = steps.find(step => step.name === name)!;
            proofStep.conclusion = 'skipped';
            assert.throws(f.verify, /required.*step is missing or replaced/i);
            proofStep.conclusion = 'success';
            assert.equal(f.verify().phase, 'stage-publish');
        }
    } finally { f.dispose(); }
});

test('offline publish guard permits first staging after a bounded validation rerun with retained authorization', () => {
    const f = fixture('stage-publish');
    try {
        const previous = run(42, 1, false);
        f.current.run_attempt = 2;
        f.request.runAttempt = '2';
        f.payloads.set(base + '/actions/runs/42/attempts/1', previous);
        f.payloads.set(base + '/actions/runs/42/attempts/2', f.current);
        const retried = jobs(f.current, 'stage-publish').slice(1);
        f.payloads.set(base + '/actions/runs/42/jobs?filter=all&per_page=100&page=1', { total_count: 5, jobs: [...jobs(previous), ...retried] });
        assert.equal(f.verify().total_attempts, 2);
        assert.equal(f.verify().phase, 'stage-publish');
    } finally { f.dispose(); }
});

test('publish guard rejects overlap hidden in an older retained attempt across same-tag run IDs', () => {
    const f = fixture();
    try {
        const previous = run(42, 1, false);
        previous.run_started_at = '2026-10-07T10:00:00Z';
        previous.updated_at = '2026-10-07T10:30:00Z';
        f.current.run_attempt = 2;
        f.request.runAttempt = '2';
        f.payloads.set(base + '/actions/runs/42/attempts/1', previous);
        f.payloads.set(base + '/actions/runs/42/attempts/2', f.current);
        f.payloads.set(base + '/actions/runs/42/jobs?filter=all&per_page=100&page=1', {
            total_count: 4, jobs: [...jobs(previous), jobs(f.current)[1]]
        });
        const other = run(41, 1, false);
        other.run_started_at = '2026-10-07T10:20:00Z';
        other.updated_at = '2026-10-07T10:40:00Z';
        f.addPrior(other);
        assert.throws(f.verify, /chronology|overlap|serialization/i);
        other.run_started_at = '2026-10-07T10:35:00Z';
        other.updated_at = '2026-10-07T10:45:00Z';
        f.payloads.set(base + '/actions/runs/41/jobs?filter=all&per_page=100&page=1', { total_count: 3, jobs: jobs(other) });
        assert.equal(f.verify().total_attempts, 3);
    } finally { f.dispose(); }
});

test('publish guard accepts fresh active staging after its last metadata update and rejects future starts', () => {
    const f = fixture('stage-publish');
    try {
        f.current.run_started_at = '2026-10-07T11:00:00Z';
        f.current.updated_at = '2026-10-07T11:00:00Z';
        f.currentJobs.splice(0, 3, ...jobs(f.current, 'stage-publish'));
        const stage = f.currentJobs[2];
        stage.started_at = '2026-10-07T11:06:00Z';
        stage.steps[0].started_at = '2026-10-07T11:06:00Z';
        assert.equal(f.verify().phase, 'stage-publish');
        stage.started_at = '2026-10-07T12:06:00Z';
        stage.steps[0].started_at = '2026-10-07T12:06:00Z';
        assert.throws(f.verify, /timestamp|future|chronology/i);
    } finally { f.dispose(); }
});

test('publish guard rejects job timestamps beyond a completed historical attempt', () => {
    const f = fixture();
    try {
        const prior = f.addPrior();
        prior.history[1].started_at = '2026-10-07T11:16:00Z';
        prior.history[1].completed_at = '2026-10-07T11:17:00Z';
        assert.throws(f.verify, /chronology|history/i);
    } finally { f.dispose(); }
});

test('publish guard accepts exactly current pending staging and rejects missing or executed pending metadata', () => {
    const f = fixture();
    try {
        const stage = f.currentJobs[2];
        Object.assign(stage, { status: 'queued', conclusion: null, started_at: null, completed_at: null });
        stage.steps = [{ name: 'Stage the validated tarball with npm Trusted Publishing', number: 1,
            status: 'queued', conclusion: null, started_at: null, completed_at: null }];
        assert.equal(f.verify().phase, 'validate');
        stage.started_at = '2026-10-07T11:54:00Z';
        assert.throws(f.verify, /queued|pending|stage|history/i);
        stage.started_at = null;
        stage.steps[0].started_at = '2026-10-07T11:54:00Z';
        assert.throws(f.verify, /unstarted|queued|pending|stage/i);
        stage.steps[0].started_at = null;
        stage.conclusion = 'failure';
        assert.throws(f.verify, /pending|stage|history/i);
        stage.conclusion = null;
        stage.name = 'Validate release package';
        assert.throws(f.verify, /pending|queued|stage|history/i);
    } finally { f.dispose(); }
});

test('publish guard rejects queued prior staging and queued staging at the current staging checkpoint', () => {
    const f = fixture();
    try {
        const prior = f.addPrior();
        Object.assign(prior.history[2], { status: 'queued', conclusion: null, started_at: null, completed_at: null });
        assert.throws(f.verify, /queued|pending|stage|history|timestamp/i);
    } finally { f.dispose(); }
    const staging = fixture('stage-publish');
    try {
        Object.assign(staging.currentJobs[2], { status: 'queued', conclusion: null, started_at: null, completed_at: null, steps: [] });
        assert.throws(staging.verify, /queued|pending|stage|history|timestamp/i);
    } finally { staging.dispose(); }
});

test('publish guard rejects missing current staging history with a complete authenticated job count', () => {
    const f = fixture();
    try {
        f.currentJobs.pop();
        const endpoint = base + '/actions/runs/42/jobs?filter=all&per_page=100&page=1';
        f.payloads.set(endpoint, { total_count: 2, jobs: f.currentJobs });
        assert.throws(f.verify, /stage.*(?:missing|history)|missing.*stage/i);
        f.currentJobs.push(jobs(f.current)[2]);
        f.payloads.set(endpoint, { total_count: 3, jobs: f.currentJobs });
        assert.equal(f.verify().phase, 'validate');
    } finally { f.dispose(); }
});

test('publish guard rejects missing or replaced authorization and foreign manual workflow identity', () => {
    const f = fixture();
    try {
        f.currentJobs[0].steps = [];
        assert.throws(f.verify, /authorization/i);
        f.currentJobs[0].steps = jobs(f.current)[0].steps;
        for (const change of [
            { event: 'push' }, { path: '.github/workflows/ci.yml' }, { head_sha: 'b'.repeat(40) },
            { head_branch: 'dev' }, { workflow_id: 8 }, { repository: { full_name: 'foreign/garda' } },
            { head_repository: { full_name: 'foreign/garda' } }
        ]) {
            const original = { ...f.current };
            Object.assign(f.current, change);
            assert.throws(f.verify, /identity|manual|workflow|repository|commit|tag/i);
            Object.assign(f.current, original);
        }
        f.currentJobs[0].conclusion = 'skipped';
        assert.throws(f.verify, /authorization/i);
    } finally { f.dispose(); }
});

test('publish guard rejects missing or replaced live tag and authenticated source content', () => {
    const f = fixture();
    try {
        const endpoint = base + '/git/ref/tags/' + tag;
        f.payloads.set(endpoint, { ref: 'refs/tags/' + tag, object: { type: 'commit', sha: 'b'.repeat(40) } });
        assert.throws(f.verify, /tag|commit/i);
        f.payloads.set(endpoint, { ref: 'refs/tags/' + tag, object: { type: 'commit', sha: commit } });
        const remote = base + '/contents/.github/workflows/publish.yml?ref=' + commit;
        f.payloads.set(remote, { type: 'file', path: '.github/workflows/publish.yml', encoding: 'base64', size: 7, content: Buffer.from('changed').toString('base64') });
        assert.throws(f.verify, /source|contract/i);
        fs.appendFileSync(path.join(f.root, sourceFiles[0]), '\n# unreviewed source\n');
        assert.throws(f.verify, /source|contract/i);
    } finally { f.dispose(); }
});

test('publish guard rejects missing or replaced local and authenticated selector source independently', () => {
    const f = fixture();
    try {
        const selector = 'scripts/manual-workflow-authorization.cjs';
        const local = path.join(f.root, selector);
        const bytes = fs.readFileSync(local);
        const remote = base + '/contents/' + selector + '?ref=' + commit;
        const original = f.payloads.get(remote);
        assert.equal(f.verify().phase, 'validate');
        fs.appendFileSync(local, '\n// unreviewed selector bytes\n');
        assert.throws(f.verify, /source.*reviewed contract/i);
        fs.writeFileSync(local, bytes);
        fs.unlinkSync(local);
        assert.throws(f.verify, /ENOENT/);
        fs.writeFileSync(local, bytes);
        assert.equal(f.verify().phase, 'validate');
        const changed = Buffer.concat([bytes, Buffer.from('\n// unreviewed selector bytes\n')]);
        f.payloads.set(remote, { type: 'file', path: selector, encoding: 'base64',
            size: changed.length, content: changed.toString('base64') });
        assert.throws(f.verify, /authenticated source.*reviewed contract/i);
        f.payloads.delete(remote);
        assert.throws(f.verify, /Unmocked authenticated endpoint/);
        f.payloads.set(remote, original);
        assert.equal(f.verify().phase, 'validate');
    } finally { f.dispose(); }
});

test('publish guard rejects missing stage history and any completed failed cancelled or uncertain staging', () => {
    const f = fixture();
    try {
        const prior = f.addPrior();
        for (const conclusion of ['success', 'failure', 'cancelled', 'timed_out', null]) {
            prior.history[2].conclusion = conclusion;
            assert.throws(f.verify, /stage|staging/i);
        }
        prior.history[2].conclusion = 'skipped';
        prior.history[2].steps = [{
            name: 'Stage the validated tarball with npm Trusted Publishing', number: 1,
            status: 'completed', conclusion: 'skipped', started_at: prior.metadata.run_started_at, completed_at: prior.metadata.updated_at
        }];
        assert.throws(f.verify, /stage|staging/i);
        prior.history.pop();
        f.payloads.set(base + '/actions/runs/41/jobs?filter=all&per_page=100&page=1', { total_count: 2, jobs: prior.history });
        assert.throws(f.verify, /stage|history|missing/i);
    } finally { f.dispose(); }
});

test('publish guard rejects replayed or missing paginated records and duplicate job identity', () => {
    const f = fixture();
    try {
        const endpoint = base + '/actions/runs/42/jobs?filter=all&per_page=100&page=1';
        f.payloads.set(endpoint, { total_count: 4, jobs: f.currentJobs });
        f.payloads.set(base + '/actions/runs/42/jobs?filter=all&per_page=100&page=2', { total_count: 4, jobs: [] });
        assert.throws(f.verify, /history|incomplete|pagination/i);
        f.payloads.set(endpoint, { total_count: 3, jobs: [f.currentJobs[0], f.currentJobs[0], f.currentJobs[2]] });
        assert.throws(f.verify, /duplicate|replay/i);
        f.payloads.set(endpoint, { total_count: 3, jobs: f.currentJobs });
        f.currentJobs[1].run_id = 7;
        assert.throws(f.verify, /job|identity/i);
    } finally { f.dispose(); }
});

test('publish guard reconstructs complete pagination without success or event filters', () => {
    const f = fixture();
    try {
        const prior = f.addPrior();
        const historyEndpoint = base + '/actions/workflows/publish.yml/runs?branch=' + tag + '&per_page=100&page=';
        f.payloads.set(historyEndpoint + '1', { total_count: 2, workflow_runs: [f.current] });
        f.payloads.set(historyEndpoint + '2', { total_count: 2, workflow_runs: [prior.metadata] });
        const jobsEndpoint = base + '/actions/runs/42/jobs?filter=all&per_page=100&page=';
        f.payloads.set(jobsEndpoint + '1', { total_count: 3, jobs: f.currentJobs.slice(0, 2) });
        f.payloads.set(jobsEndpoint + '2', { total_count: 3, jobs: f.currentJobs.slice(2) });
        assert.equal(f.verify().total_attempts, 2);
        assert.ok(f.calls.includes(historyEndpoint + '2'));
        assert.ok(f.calls.every(endpoint => !endpoint.includes('event=') && !endpoint.includes('status=')));
    } finally { f.dispose(); }
});

test('publish guard rejects retry exhaustion across distinct same-tag run IDs and a later concurrent run', () => {
    const f = fixture();
    try {
        f.addPrior();
        f.addPrior(run(40, 1, false));
        assert.equal(f.verify().total_attempts, 3);
        f.addPrior(run(39, 1, false));
        assert.throws(f.verify, /budget|bound|history/i);
    } finally { f.dispose(); }
    const concurrent = fixture();
    try {
        concurrent.addPrior(run(43, 1, true));
        assert.throws(concurrent.verify, /active|concurrent|chronology|current/i);
    } finally { concurrent.dispose(); }
});

test('publish guard rejects unsafe IDs inputs and missing or stale attempt metadata', () => {
    const f = fixture();
    try {
        for (const id of ['01', '-1', '1e2', '0', '9007199254740992', '42;echo unsafe']) {
            f.request.runId = id;
            assert.throws(f.verify, /integer|identity|ID/i);
        }
        f.request.runId = '42';
        f.request.runAttempt = '2';
        assert.throws(f.verify, /attempt|identity/i);
        f.request.runAttempt = '1';
        f.current.run_started_at = '2026-10-05T11:50:00Z';
        assert.throws(f.verify, /stale|timestamp|time/i);
    } finally { f.dispose(); }
});

test('publish guard accepts bounded annotated tag resolution and rejects tag cycles', () => {
    const f = fixture();
    try {
        const digest = 'b'.repeat(40);
        f.payloads.set(base + '/git/ref/tags/' + tag, { ref: 'refs/tags/' + tag, object: { type: 'tag', sha: digest } });
        f.payloads.set(base + '/git/tags/' + digest, { sha: digest, tag, object: { type: 'commit', sha: commit } });
        assert.equal(f.verify().tag, tag);
        f.payloads.set(base + '/git/tags/' + digest, { sha: digest, tag, object: { type: 'tag', sha: digest } });
        assert.throws(f.verify, /tag|cycle|bound/i);
    } finally { f.dispose(); }
});

test('publish guard rejects symlinked or replaced ordinary source inputs', () => {
    const f = fixture();
    try {
        const original = path.join(f.root, sourceFiles[0]);
        const target = original + '.real';
        fs.renameSync(original, target);
        fs.symlinkSync(target, original);
        assert.throws(f.verify, /source|regular|symlink/i);
    } finally { f.dispose(); }
});

test('publish guard preserves CRLF compatibility and rejects replaced executable scalar comments', () => {
    const f = fixture();
    try {
        const file = path.join(f.root, sourceFiles[0]);
        const original = fs.readFileSync(file, 'utf8');
        fs.writeFileSync(file, original.replace(/\n/gu, '\r\n'));
        assert.equal(f.verify().run_id, 42);
        fs.writeFileSync(file, original.replace('set -euo pipefail', 'set -euo pipefail\n          # ${{ github.event.inputs.commit }}'));
        assert.throws(f.verify, /source|contract/i);
    } finally { f.dispose(); }
});

test('publish guard rejects missing or replayed tag and invocation identity on final recheck', () => {
    const f = fixture();
    try {
        let tagReads = 0;
        const mutatedTag: Fetch = endpoint => endpoint === base + '/git/ref/tags/' + tag && ++tagReads === 2
            ? { ref: 'refs/tags/' + tag, object: { type: 'commit', sha: 'b'.repeat(40) } } : f.fetch(endpoint);
        assert.throws(() => verifyPublishHistory(f.request, { root: f.root, now, fetch: mutatedTag }), /tag|commit/i);
        let runReads = 0;
        const mutatedRun: Fetch = endpoint => {
            if (endpoint === base + '/actions/runs/42' && ++runReads === 3) {
                return { ...f.current, run_started_at: '2026-10-07T11:51:00Z' };
            }
            return f.fetch(endpoint);
        };
        assert.throws(() => verifyPublishHistory(f.request, { root: f.root, now, fetch: mutatedRun }), /changed|identity/i);
    } finally { f.dispose(); }
});

test('publish guard rejects missing or reversed retained attempt metadata and current npm-step ordering', () => {
    const f = fixture();
    try {
        const previous = run(42, 1, false);
        f.current.run_attempt = 2;
        f.request.runAttempt = '2';
        f.payloads.set(base + '/actions/runs/42/attempts/1', { ...previous, workflow_id: 9 });
        f.payloads.set(base + '/actions/runs/42/attempts/2', f.current);
        f.payloads.set(base + '/actions/runs/42/jobs?filter=all&per_page=100&page=1', {
            total_count: 4, jobs: [...jobs(previous), jobs(f.current)[1]]
        });
        assert.throws(f.verify, /identity|attempt/i);
        previous.updated_at = '2026-10-07T11:55:00Z';
        f.payloads.set(base + '/actions/runs/42/attempts/1', previous);
        assert.throws(f.verify, /chronology|overlap/i);
    } finally { f.dispose(); }
    const stage = fixture('stage-publish');
    try {
        stage.currentJobs[2].steps[1].number = 0;
        assert.throws(stage.verify, /step|identity/i);
        stage.currentJobs[2].steps.pop();
        assert.throws(stage.verify, /missing|replaced/i);
    } finally { stage.dispose(); }
});

test('publish history CLI rejects missing or automatic runner authority without a verification marker', () => {
    const mutable = require('node:child_process') as typeof childProcess;
    const result = mutable.spawnSync(process.execPath, [script, 'validate'], {
        encoding: 'utf8', env: { ...process.env, GITHUB_EVENT_NAME: 'push' }
    });
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout.includes('PUBLISH_HISTORY_VERIFIED'), false);
    assert.match(result.stderr, /manual tag runner invocation/);
});

test('publish guard rejects missing or malformed transport with fixed shell-free GET bounds and redacted errors', () => {
    const f = fixture();
    const mutable = require('node:child_process') as {
        spawnSync: (command: string, args: readonly string[], options: childProcess.SpawnSyncOptionsWithStringEncoding) => childProcess.SpawnSyncReturns<string>;
    };
    const saved = mutable.spawnSync;
    const calls: Array<{ args: readonly string[]; options: childProcess.SpawnSyncOptions }> = [];
    try {
        mutable.spawnSync = (command, args, options) => {
            assert.equal(command, 'gh');
            calls.push({ args, options });
            return { status: 0, stdout: JSON.stringify(f.payloads.get(args[5])), stderr: '', signal: null, pid: 1, output: [] };
        };
        assert.equal(verifyPublishHistory(f.request, { root: f.root, now }).run_id, 42);
        assert.ok(calls.every(call => call.args.slice(0, 5).join(' ') === 'api --hostname github.com --method GET'));
        assert.ok(calls.every(call => !call.options.shell && call.options.maxBuffer === 16 * 1024 * 1024 && call.options.timeout === 30000));
        mutable.spawnSync = () => ({ status: 1, stdout: '', stderr: 'SECRET_TRANSPORT_VALUE', signal: null, pid: 1, output: [] });
        assert.throws(() => verifyPublishHistory(f.request, { root: f.root, now }), error => {
            assert.ok(error instanceof Error);
            assert.match(error.message, /authenticated|unavailable/i);
            assert.equal(error.message.includes('SECRET_TRANSPORT_VALUE'), false);
            return true;
        });
        mutable.spawnSync = () => ({ status: 0, stdout: '{malformed', stderr: '', signal: null, pid: 1, output: [] });
        assert.throws(() => verifyPublishHistory(f.request, { root: f.root, now }), /unavailable|malformed/i);
        const raw = fs.readFileSync(path.join(f.root, sourceFiles[0]));
        assert.equal(crypto.createHash('sha256').update(raw).digest('hex'), '48f688bc902041781ed07ed5eefcb2add08dbbc7dbacba6ec09d517a37c775af');
    } finally { mutable.spawnSync = saved; f.dispose(); }
});
