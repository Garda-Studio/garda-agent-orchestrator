import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import * as os from 'node:os';
import * as childProcess from 'node:child_process';
import * as path from 'node:path';

const security = require(path.join(process.cwd(), 'scripts/release-security-evidence.cjs')) as {
    MAX_EVIDENCE_AGE_MS: number;
    attestOrVerify: (mode: 'attest' | 'verify', argv: string[], root: string, clock: Date,
        fetch: (repository: string, runId: number) => { run: object; jobs: object; fetchAttempt?: (attempt: number) => object }) => {
        evidencePath: string; evidenceSha256: string;
    };
    assertSecurityWorkflow: (content: string, selector?: string) => void;
    validateSecurityRun: (run: object, jobs: object, expected: object, now: Date, fetchAttempt?: (attempt: number) => object) => object;
    readJobsPayload: (payload: object) => object[];
    assertDevGraph: (packageJson: object, lockfile: object) => void;
    createEvidence: (candidate: object, scan: object, attestedAt: string) => object;
    assertEvidenceMatches: (recorded: object, current: object) => void;
    readCandidateContext: (root: string, directory: string, commitSha: string, tag: string, tarballSha: string, tarballName: string, repository: string) => object;
};

const commit = 'a'.repeat(40);
const repository = 'owner/repository';
const now = new Date('2026-09-25T12:00:00Z');
const expected = { commit, repository, runId: 42 };
const successfulStep = (name: string) => ({ name, status: 'completed', conclusion: 'success' });

function fixture() {
    const run = {
        id: 42,
        head_sha: commit,
        head_branch: 'dev',
        repository: { full_name: repository },
        path: '.github/workflows/security.yml',
        event: 'workflow_dispatch',
        status: 'completed',
        conclusion: 'success',
        run_attempt: 1,
        run_started_at: '2026-09-25T10:00:00Z',
        updated_at: '2026-09-25T10:20:00Z'
    };
    const auditJob = {
        id: 101,
        run_id: 42,
        run_attempt: 1,
        head_sha: commit,
        name: 'npm audit',
        status: 'completed',
        conclusion: 'success',
        started_at: '2026-09-25T10:01:00Z',
        completed_at: '2026-09-25T10:10:00Z',
        steps: [
            successfulStep('Pin release audit npm CLI'),
            successfulStep('Install dependencies'),
            successfulStep('Audit dependencies')
        ]
    };
    const osvJob = {
        ...auditJob,
        id: 102,
        name: 'OSV Vulnerability Scan / osv-scan',
        completed_at: '2026-09-25T10:18:00Z',
        steps: [
            { name: 'Download custom artifact if specified', status: 'completed', conclusion: 'skipped' },
            successfulStep('Run scanner'),
            successfulStep('Run osv-scanner-reporter')
        ]
    };
    const authorizeJob = { ...auditJob, id: 100, name: 'Authorize Security selection',
        started_at: '2026-09-25T10:00:00Z', completed_at: '2026-09-25T10:01:00Z',
        steps: [successfulStep('Authorize selected jobs')] };
    return { run, jobs: { total_count: 3, jobs: [auditJob, osvJob, authorizeJob] } };
}

test('security evidence accepts only the successful full-graph npm and OSV run', () => {
    const { run, jobs } = fixture();
    assert.deepEqual(security.validateSecurityRun(run, jobs, expected, now), {
        run_id: 42,
        run_attempt: 1,
        run_event: 'workflow_dispatch',
        run_completed_at_utc: '2026-09-25T10:20:00Z',
        authorization_job_id: 100,
        audit_job_id: 101,
        osv_job_ids: [102],
        job_attempts: [
            { name: 'Authorize Security selection', id: 100, attempt: 1 },
            { name: 'npm audit', id: 101, attempt: 1 },
            { name: 'OSV Vulnerability Scan / osv-scan', id: 102, attempt: 1 }
        ]
    });
});

test('security evidence rejects a stale or foreign workflow run', () => {
    for (const mutate of [
        (run: Record<string, unknown>) => { run.head_sha = 'b'.repeat(40); },
        (run: Record<string, unknown>) => { run.repository = { full_name: 'other/repository' }; },
        (run: Record<string, unknown>) => { run.path = '.github/workflows/other.yml@dev'; },
        (run: Record<string, unknown>) => { run.event = 'pull_request'; },
        (run: Record<string, unknown>) => { run.conclusion = 'skipped'; },
        (run: Record<string, unknown>) => { run.updated_at = '2026-09-23T10:20:00Z'; }
    ]) {
        const { run, jobs } = fixture();
        mutate(run);
        assert.throws(() => security.validateSecurityRun(run, jobs, expected, now));
    }
});

test('security evidence rejects incomplete or bypassed jobs and required steps', () => {
    for (const mutate of [
        (jobs: ReturnType<typeof fixture>['jobs']) => { jobs.total_count = 4; },
        (jobs: ReturnType<typeof fixture>['jobs']) => { jobs.jobs[0].head_sha = 'b'.repeat(40); },
        (jobs: ReturnType<typeof fixture>['jobs']) => { jobs.jobs[0].conclusion = 'skipped'; },
        (jobs: ReturnType<typeof fixture>['jobs']) => { jobs.jobs[0].steps[2].conclusion = 'skipped'; },
        (jobs: ReturnType<typeof fixture>['jobs']) => { jobs.jobs[1].steps[1].conclusion = 'skipped'; },
        (jobs: ReturnType<typeof fixture>['jobs']) => { jobs.jobs[1].steps[2].conclusion = 'skipped'; },
        (jobs: ReturnType<typeof fixture>['jobs']) => { jobs.jobs.splice(1, 1); jobs.total_count = 2; }
    ]) {
        const { run, jobs } = fixture();
        mutate(jobs);
        assert.throws(() => security.validateSecurityRun(run, jobs, expected, now));
    }
});

test('security workflow and root lockfile bind the reviewed scan and release tools', () => {
    const root = process.cwd();
    const workflow = fs.readFileSync(path.join(root, '.github/workflows/security.yml'), 'utf8');
    security.assertSecurityWorkflow(workflow);
    assert.throws(() => security.assertSecurityWorkflow(workflow.replace('fail-on-vuln: true', 'fail-on-vuln: false')));
    const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const lockfile = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
    security.assertDevGraph(packageJson, lockfile);
    delete lockfile.packages[''].devDependencies['@cyclonedx/cyclonedx-npm'];
    assert.throws(() => security.assertDevGraph(packageJson, lockfile));
});

test('security evidence rejects scalar source drift while accepting CRLF', () => {
    const workflow = fs.readFileSync(path.join(process.cwd(), '.github/workflows/security.yml'), 'utf8');
    const anchor = '          set -euo pipefail\n';
    assert.ok(workflow.includes(anchor));
    security.assertSecurityWorkflow(workflow);
    security.assertSecurityWorkflow(workflow.replace(/\r?\n/gu, '\r\n'));
    for (const inserted of [
        "          # ${{ fromJSON('\"\\nexit 0\\n\"') }}\n",
        '          # An unreviewed scalar comment\n',
        '\n',
        '          \n'
    ]) {
        const changed = workflow.replace(anchor, inserted + anchor);
        assert.notEqual(changed, workflow);
        assert.throws(() => security.assertSecurityWorkflow(changed), /reviewed manually authorized audit and OSV contract/);
    }
    assert.throws(() => security.assertSecurityWorkflow(workflow.trimEnd()), /reviewed manually authorized audit and OSV contract/);
});

test('candidate evidence binds exact artifact and lockfile digests', () => {
    const candidate = {
        commit_sha: commit,
        tag: 'v1.5.0',
        tarball_name: 'candidate.tgz',
        tarball_sha256: 'b'.repeat(64),
        lockfile_sha256: 'c'.repeat(64),
        repository
    };
    const scan = security.validateSecurityRun(fixture().run, fixture().jobs, expected, now);
    const recorded = security.createEvidence(candidate, scan, now.toISOString());
    security.assertEvidenceMatches(recorded, security.createEvidence(candidate, scan, now.toISOString()));
    for (const changed of [
        { ...candidate, tarball_sha256: 'd'.repeat(64) },
        { ...candidate, lockfile_sha256: 'd'.repeat(64) },
        { ...candidate, commit_sha: 'd'.repeat(40) }
    ]) {
        assert.throws(() => security.assertEvidenceMatches(
            recorded, security.createEvidence(changed, scan, now.toISOString())));
    }
});

test('security evidence serializes the independently specified schema-2 scan contract', () => {
    const candidate = { commit_sha: commit, tag: 'v1.5.0', tarball_name: 'candidate.tgz',
        tarball_sha256: 'b'.repeat(64), lockfile_sha256: 'c'.repeat(64), repository };
    const { run, jobs } = fixture();
    assert.deepEqual(security.createEvidence(candidate,
        security.validateSecurityRun(run, jobs, expected, now), now.toISOString()), {
        schema_version: 2,
        source: 'authenticated_github_actions_api',
        candidate,
        security: {
            run_id: 42,
            run_attempt: 1,
            run_event: 'workflow_dispatch',
            run_completed_at_utc: '2026-09-25T10:20:00Z',
            authorization_job_id: 100,
            audit_job_id: 101,
            osv_job_ids: [102],
            job_attempts: [
                { name: 'Authorize Security selection', id: 100, attempt: 1 },
                { name: 'npm audit', id: 101, attempt: 1 },
                { name: 'OSV Vulnerability Scan / osv-scan', id: 102, attempt: 1 }
            ],
            workflow_sha256: '6052f5d04a1eae574aae2e7236d424c7f4e48a8aedcd39ae6cf4220f24d83ed5',
            selector_sha256: 'cb34c3544940e746ad023a8fa4c9e6de4b789fec05e1cdef106bbb7c0da034a5',
            node_version: '24',
            npm_cli_version: '11.15.0',
            npm_audit_registry: 'https://registry.npmjs.org',
            npm_install_ignore_scripts: true,
            npm_audit_lockfile_only: true,
            npm_audit_scope: 'all_dependencies_including_dev',
            npm_audit_policy: 'high_or_critical_blocking',
            osv_action_ref: 'google/osv-scanner-action/.github/workflows/osv-scanner-reusable.yml@b77c075a1235514558f0eb88dbd31e22c45e0cd2',
            osv_checkout_ref: commit,
            osv_scan_args: '--lockfile=package-lock.json',
            osv_fail_on_vuln: true
        },
        attested_at_utc: '2026-09-25T12:00:00.000Z'
    });
});

test('security evidence rejects a foreign repository', () => {
    const { run, jobs } = fixture();
    run.repository.full_name = 'other/repository';
    assert.throws(() => security.validateSecurityRun(run, jobs, expected, now));
});

test('security evidence rejects a missing successful OSV reporter', () => {
    const { run, jobs } = fixture();
    jobs.jobs[1].steps[2].conclusion = 'skipped';
    assert.throws(() => security.validateSecurityRun(run, jobs, expected, now));
});

test('security evidence rejects a stale expired scan', () => {
    const { run, jobs } = fixture();
    run.updated_at = '2026-09-23T10:20:00Z';
    assert.throws(() => security.validateSecurityRun(run, jobs, expected, now));
});

test('security evidence rejects a replaced nonblocking OSV workflow contract', () => {
    const workflow = fs.readFileSync(path.join(process.cwd(), '.github/workflows/security.yml'), 'utf8');
    assert.throws(() => security.assertSecurityWorkflow(workflow.replace('fail-on-vuln: true', 'fail-on-vuln: false')));
});

test('security evidence rejects a replaced candidate digest', () => {
    const candidate = { commit_sha: commit, tag: 'v1.5.0', tarball_sha256: 'b'.repeat(64) };
    const recorded = security.createEvidence(candidate, {}, now.toISOString());
    const changed = security.createEvidence({ ...candidate, tarball_sha256: 'c'.repeat(64) }, {}, now.toISOString());
    assert.throws(() => security.assertEvidenceMatches(recorded, changed));
});

test('security evidence rejects a missing release-tool dependency', () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));
    const lockfile = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package-lock.json'), 'utf8'));
    delete lockfile.packages[''].devDependencies['@cyclonedx/cyclonedx-npm'];
    assert.throws(() => security.assertDevGraph(packageJson, lockfile));
});
test('security evidence rejects a replaced dirty candidate checkout', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-security-evidence-'));
    const git = (...args: string[]) => {
        const result = childProcess.spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
        assert.equal(result.status, 0, result.stderr);
        return result.stdout.trim();
    };
    try {
        git('init', '-q');
        git('config', 'user.name', 'Garda Fixture');
        git('config', 'user.email', 'garda@example.invalid');
        fs.writeFileSync(path.join(root, 'tracked.txt'), 'original');
        git('add', 'tracked.txt');
        git('commit', '-q', '--no-gpg-sign', '-m', 'fixture');
        const fixtureCommit = git('rev-parse', 'HEAD');
        fs.writeFileSync(path.join(root, 'tracked.txt'), 'changed');
        assert.throws(() => security.readCandidateContext(root, root, fixtureCommit, 'v1.5.0',
            'b'.repeat(64), 'candidate.tgz', repository), /not clean/);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
test('security evidence accepts a matching branch-qualified workflow path', () => {
    const { run, jobs } = fixture();
    run.path = '.github/workflows/security.yml@dev';
    assert.doesNotThrow(() => security.validateSecurityRun(run, jobs, expected, now));
});

test('security evidence rejects a foreign branch-qualified workflow path', () => {
    const { run, jobs } = fixture();
    run.path = '.github/workflows/security.yml@master';
    assert.throws(() => security.validateSecurityRun(run, jobs, expected, now));
});

test('security evidence rejects automatic push PR and scheduled runs', () => {
    const { run, jobs } = fixture();
    for (const event of ['push', 'pull_request', 'schedule']) {
        assert.throws(() => security.validateSecurityRun({ ...run, event }, jobs, expected, now));
    }
});

test('security evidence rejects missing authorization and bypassed authorization steps', () => {
    const { run, jobs } = fixture();
    assert.throws(() => security.validateSecurityRun(run,
        { total_count: 2, jobs: jobs.jobs.slice(0, 2) }, expected, now));
    jobs.jobs[2].steps[0].conclusion = 'skipped';
    assert.throws(() => security.validateSecurityRun(run, jobs, expected, now));
});

test('security job pagination rejects inconsistent totals empty pages and unbounded history', () => {
    const { jobs } = fixture();
    assert.deepEqual(security.readJobsPayload([{ total_count: 3, jobs: jobs.jobs.slice(0, 1) },
        { total_count: 3, jobs: jobs.jobs.slice(1) }]), jobs.jobs);
    assert.throws(() => security.readJobsPayload([{ total_count: 3, jobs: jobs.jobs.slice(0, 1) },
        { total_count: 2, jobs: jobs.jobs.slice(1) }]));
    assert.throws(() => security.readJobsPayload([]));
    assert.throws(() => security.readJobsPayload({ total_count: 1001, jobs: Array(1001).fill(jobs.jobs[0]) }));
});

function retryFixture() {
    const { run, jobs } = fixture();
    const prior = { ...run, conclusion: 'failure' };
    const retry = { ...jobs.jobs[1], id: 202, run_attempt: 2,
        started_at: '2026-09-25T10:30:00Z', completed_at: '2026-09-25T10:40:00Z' };
    jobs.jobs[1].conclusion = 'failure';
    jobs.jobs.push(retry);
    jobs.total_count = jobs.jobs.length;
    Object.assign(run, { run_attempt: 2, run_started_at: '2026-09-25T10:30:00Z', updated_at: '2026-09-25T10:45:00Z' });
    const calls: number[] = [];
    const fetchAttempt = (attempt: number) => { calls.push(attempt); assert.equal(attempt, 1); return prior; };
    return { run, jobs, prior, retry, calls, fetchAttempt };
}

test('security evidence accepts failed-job reruns with authenticated retained full-scan history', () => {
    const data = retryFixture();
    const result = security.validateSecurityRun(data.run, [
        { total_count: 4, jobs: data.jobs.jobs.slice(0, 2) },
        { total_count: 4, jobs: data.jobs.jobs.slice(2) }
    ], expected, now, data.fetchAttempt) as { audit_job_id: number; osv_job_ids: number[]; job_attempts: object[] };
    assert.equal(result.audit_job_id, 101);
    assert.deepEqual(result.osv_job_ids, [202]);
    assert.deepEqual(result.job_attempts, [
        { name: 'Authorize Security selection', id: 100, attempt: 1 },
        { name: 'npm audit', id: 101, attempt: 1 },
        { name: 'OSV Vulnerability Scan / osv-scan', id: 202, attempt: 2 }
    ]);
    assert.deepEqual(data.calls, [1]);
});

test('security evidence rejects missing authenticated attempt metadata', () => {
    const data = retryFixture();
    assert.throws(() => security.validateSecurityRun(data.run, data.jobs, expected, now));
});

test('security evidence rejects duplicate job identities attempts and replayed current coverage', () => {
    const { run, jobs } = fixture();
    assert.throws(() => security.validateSecurityRun(run, { total_count: 4,
        jobs: [...jobs.jobs, { ...jobs.jobs[0], id: 999 }] }, expected, now));
    jobs.jobs[1].id = jobs.jobs[0].id;
    assert.throws(() => security.validateSecurityRun(run, jobs, expected, now));
    jobs.jobs[1].id = 102;
    assert.throws(() => security.validateSecurityRun({ ...run, run_attempt: 2 }, jobs, expected, now,
        () => ({ ...run })));
    for (const run_attempt of [0, 2, undefined]) {
        assert.throws(() => security.validateSecurityRun(run, { ...jobs,
            jobs: [{ ...jobs.jobs[0], run_attempt }, ...jobs.jobs.slice(1)] }, expected, now));
    }
});

test('security evidence rejects latest failures and skips despite an earlier successful job', () => {
    const data = retryFixture();
    data.jobs.jobs[1].conclusion = 'success';
    data.retry.conclusion = 'failure';
    assert.throws(() => security.validateSecurityRun(data.run, data.jobs, expected, now, data.fetchAttempt));
    for (const conclusion of ['skipped', 'cancelled']) {
        data.retry.conclusion = conclusion;
        assert.throws(() => security.validateSecurityRun(data.run, data.jobs, expected, now, data.fetchAttempt));
    }
});

test('security evidence rejects foreign stale reversed and overlapping attempt provenance', () => {
    const data = retryFixture();
    for (const replacement of [
        { id: 99 }, { head_sha: 'b'.repeat(40) }, { repository: { full_name: 'foreign/repository' } },
        { run_attempt: 2 }, { event: 'push' }, { path: '.github/workflows/security.yml@master' },
        { head_branch: 'main' }, { status: 'queued' }, { updated_at: '2026-09-23T10:20:00Z' },
        { run_started_at: '2026-09-25T11:00:00Z', updated_at: '2026-09-25T11:05:00Z' },
        { updated_at: '2026-09-25T10:40:00Z' }
    ]) {
        assert.throws(() => security.validateSecurityRun(data.run, data.jobs, expected, now,
            () => ({ ...data.prior, ...replacement })));
    }
});

test('security evidence rejects jobs outside their authenticated attempt timeline', () => {
    const data = retryFixture();
    data.jobs.jobs[0].started_at = '2026-09-25T09:00:00Z';
    assert.throws(() => security.validateSecurityRun(data.run, data.jobs, expected, now, data.fetchAttempt));
    data.jobs.jobs[0].started_at = '2026-09-25T10:01:00Z';
    data.retry.completed_at = '2026-09-25T11:00:00Z';
    assert.throws(() => security.validateSecurityRun(data.run, data.jobs, expected, now, data.fetchAttempt));
});

test('security evidence accepts only superseded earlier unexpanded skipped reusable jobs', () => {
    const data = retryFixture();
    const skipped = { ...data.jobs.jobs[1], name: 'OSV Vulnerability Scan', conclusion: 'skipped', steps: [] };
    data.jobs.jobs.splice(1, 1, skipped);
    assert.doesNotThrow(() => security.validateSecurityRun(data.run, data.jobs, expected, now, data.fetchAttempt));
    for (const replacement of [{ name: 'OSV Vulnerability Scan / foreign' }, { conclusion: 'success' },
        { run_attempt: 2 }, { status: 'queued' }, { steps: [successfulStep('Run scanner')] }]) {
        assert.throws(() => security.validateSecurityRun(data.run, { ...data.jobs,
            jobs: [data.jobs.jobs[0], { ...skipped, ...replacement }, ...data.jobs.jobs.slice(2)] }, expected, now, data.fetchAttempt));
    }
});

test('security workflow rejects replaced manual authorization and selector contracts', () => {
    const workflow = fs.readFileSync(path.join(process.cwd(), '.github/workflows/security.yml'), 'utf8');
    const selector = fs.readFileSync(path.join(process.cwd(), 'scripts/manual-workflow-authorization.cjs'), 'utf8');
    assert.doesNotThrow(() => security.assertSecurityWorkflow(workflow, selector));
    assert.doesNotMatch(workflow, /^  (?:push|pull_request|schedule):/mu);
    assert.match(workflow, /options: \[npm-audit, osv, all\]/u);
    assert.match(workflow, /options: \[ubuntu-latest, all\]/u);
    assert.match(workflow, /options: \['24', all\]/u);
    assert.match(workflow, /MANUAL_WORKFLOW: security/u);
    assert.match(workflow, /ref: \$\{\{ github\.sha \}\}/u);
    assert.throws(() => security.assertSecurityWorkflow(workflow, selector + '\n// replaced selector\n'));
    assert.throws(() => security.assertSecurityWorkflow(workflow.replace('needs: [authorize]', 'needs: []'), selector));
});
test('security evidence rejects a replaced lifecycle-enabled npm installation', () => {
    const workflow = fs.readFileSync(path.join(process.cwd(), '.github/workflows/security.yml'), 'utf8');
    const downgraded = workflow.replace('npm ci --ignore-scripts', 'npm ci');
    assert.throws(() => security.assertSecurityWorkflow(downgraded));
});

test('security evidence rejects a replaced development-omitting audit policy', () => {
    const workflow = fs.readFileSync(path.join(process.cwd(), '.github/workflows/security.yml'), 'utf8');
    const downgraded = workflow.replace('npm audit --package-lock=true --package-lock-only --ignore-scripts --include=prod --include=dev',
        'npm audit --package-lock=true --package-lock-only --ignore-scripts --include=prod --omit=dev');
    assert.throws(() => security.assertSecurityWorkflow(downgraded));
});

test('security evidence rejects a replaced advisory registry', () => {
    const workflow = fs.readFileSync(path.join(process.cwd(), '.github/workflows/security.yml'), 'utf8');
    assert.throws(() => security.assertSecurityWorkflow(workflow.replaceAll('https://registry.npmjs.org', 'https://foreign.invalid')));
});

test('security audit policy prevents candidate lifecycle and npm configuration downgrade offline', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-security-npm-policy-'));
    const policyArgs = ['--ignore-scripts', '--include=prod', '--include=dev', '--include=optional', '--include=peer',
        '--registry=https://registry.npmjs.org', '--no-audit', '--no-fund', '--offline'];
    const runNpm = (args: string[]) => childProcess.spawnSync(
        process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : 'npm',
        process.platform === 'win32' ? ['/d', '/s', '/c', 'npm ' + args.join(' ')] : args,
        { cwd: root, encoding: 'utf8', windowsHide: true });
    try {
        const rootPackage = { name: 'garda-security-fixture', version: '1.0.0',
            scripts: { postinstall: 'node hook.cjs' } };
        fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(rootPackage));
        fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({ name: rootPackage.name,
            version: rootPackage.version, lockfileVersion: 3, packages: { '': { name: rootPackage.name,
                version: rootPackage.version, hasInstallScript: true } } }));
        fs.writeFileSync(path.join(root, 'hook.cjs'), "require('node:fs').writeFileSync('lifecycle-ran', 'unsafe')");
        fs.writeFileSync(path.join(root, '.npmrc'), 'ignore-scripts=false\nomit=dev\nregistry=https://foreign.invalid\n');
        const install = runNpm(['ci', ...policyArgs]);
        assert.equal(install.status, 0, install.stderr);
        assert.equal(fs.existsSync(path.join(root, 'lifecycle-ran')), false);
        const includes = runNpm(['config', 'get', 'include', ...policyArgs]);
        assert.equal(includes.status, 0, includes.stderr);
        assert.match(includes.stdout, /dev/);
        const registry = runNpm(['config', 'get', 'registry', ...policyArgs]);
        assert.equal(registry.status, 0, registry.stderr);
        assert.equal(new URL(registry.stdout.trim()).href, 'https://registry.npmjs.org/');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('security evidence accepts Git-valid nested and non-ASCII release branches', () => {
    for (const branch of ['release/1.5/rc1', 'release/1.5+rc@team', 'release/候補/rc1', 'release/x;literal']) {
        for (const qualified of [false, true]) {
            const { run, jobs } = fixture();
            run.head_branch = branch;
            run.path = '.github/workflows/security.yml' + (qualified ? '@' + branch : '');
            assert.doesNotThrow(() => security.validateSecurityRun(run, jobs, expected, now), branch);
        }
    }
});

test('security evidence rejects malformed and foreign release branches', () => {
    for (const branch of ['feature/rc1', 'release/', 'release//rc1', 'release/a..b', 'release/a.lock',
        'release/.hidden', 'release/a@{1}', 'release/a b', 'release/a\\b', 'release/a~b', 'release/a.']) {
        const { run, jobs } = fixture();
        run.head_branch = branch;
        assert.throws(() => security.validateSecurityRun(run, jobs, expected, now), /another release commit/, branch);
    }
});

function lifecycleFixture(t: TestContext) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-security-lifecycle-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const repoRoot = path.join(root, 'repository');
    const directory = path.join(root, 'candidate');
    const packedRoot = path.join(root, 'pack-input');
    fs.mkdirSync(path.join(repoRoot, '.github', 'workflows'), { recursive: true });
    fs.mkdirSync(directory);
    fs.mkdirSync(path.join(packedRoot, 'package'), { recursive: true });
    const packageJson = { name: 'garda-agent-orchestrator', version: '1.5.0',
        devDependencies: { '@cyclonedx/cyclonedx-npm': '1.0.0' } };
    const packageBytes = JSON.stringify(packageJson);
    fs.writeFileSync(path.join(repoRoot, 'package.json'), packageBytes);
    fs.writeFileSync(path.join(repoRoot, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3,
        packages: { '': { devDependencies: packageJson.devDependencies } } }));
    fs.copyFileSync(path.join(process.cwd(), '.github/workflows/security.yml'),
        path.join(repoRoot, '.github/workflows/security.yml'));
    fs.mkdirSync(path.join(repoRoot, 'scripts'));
    fs.copyFileSync(path.join(process.cwd(), 'scripts/manual-workflow-authorization.cjs'),
        path.join(repoRoot, 'scripts/manual-workflow-authorization.cjs'));
    const git = (...args: string[]) => {
        const result = childProcess.spawnSync('git', ['-c', 'core.hooksPath=' + path.join(root, 'empty-hooks'), ...args],
            { cwd: repoRoot, encoding: 'utf8', windowsHide: true });
        assert.equal(result.status, 0, result.stderr);
        return result.stdout.trim();
    };
    git('init', '-q');
    git('config', 'user.name', 'Garda Fixture');
    git('config', 'user.email', 'garda@example.invalid');
    git('config', 'core.autocrlf', 'false');
    git('add', '.');
    git('commit', '-q', '--no-gpg-sign', '-m', 'fixture');
    const fixtureCommit = git('rev-parse', 'HEAD');
    fs.writeFileSync(path.join(packedRoot, 'package', 'package.json'), packageBytes);
    const tarballName = 'candidate.tgz';
    const tarballPath = path.join(directory, tarballName);
    const tar = childProcess.spawnSync('tar', ['-C', packedRoot, '-czf', tarballPath, 'package'],
        { encoding: 'utf8', windowsHide: true });
    assert.equal(tar.status, 0, tar.stderr);
    const candidate = require(path.join(process.cwd(), 'scripts/release-candidate.cjs')) as {
        createManifest: (report: object[], directory: string, commit: string, tag: string,
            name: string, version: string) => { tarball_sha256: string };
    };
    const manifest = candidate.createManifest([{ name: packageJson.name, version: packageJson.version,
        filename: tarballName, size: fs.statSync(tarballPath).size, entryCount: 1,
        unpackedSize: Buffer.byteLength(packageBytes),
        files: [{ path: 'package.json', size: Buffer.byteLength(packageBytes) }] }],
        directory, fixtureCommit, 'v1.5.0', packageJson.name, packageJson.version);
    fs.writeFileSync(path.join(directory, 'candidate-manifest.json'), JSON.stringify(manifest));
    const payload = fixture();
    payload.run.head_sha = fixtureCommit;
    payload.run.head_branch = 'release/1.5/rc1';
    for (const job of payload.jobs.jobs) job.head_sha = fixtureCommit;
    const calls: [string, number][] = [];
    const fetch = (requestedRepository: string, runId: number) => {
        calls.push([requestedRepository, runId]);
        assert.equal(requestedRepository, repository);
        assert.equal(runId, expected.runId);
        return structuredClone(payload);
    };
    const args = [directory, fixtureCommit, 'v1.5.0', manifest.tarball_sha256, tarballName, repository];
    return { repoRoot, directory, args, payload, calls, fetch };
}

test('security attest and verify round trip bind real candidate files and refetch the run', (t) => {
    const data = lifecycleFixture(t);
    const created = security.attestOrVerify('attest', [...data.args, '42'], data.repoRoot, now, data.fetch);
    const evidenceBytes = fs.readFileSync(created.evidencePath);
    assert.equal(created.evidenceSha256, crypto.createHash('sha256').update(evidenceBytes).digest('hex'));
    const record = JSON.parse(evidenceBytes.toString('utf8'));
    assert.equal(record.candidate.commit_sha, data.args[1]);
    assert.equal(record.candidate.tarball_sha256, data.args[3]);
    assert.equal(record.schema_version, 2);
    assert.equal(record.security.workflow_sha256, '6052f5d04a1eae574aae2e7236d424c7f4e48a8aedcd39ae6cf4220f24d83ed5');
    assert.equal(record.security.selector_sha256, 'cb34c3544940e746ad023a8fa4c9e6de4b789fec05e1cdef106bbb7c0da034a5');
    assert.equal(record.security.osv_checkout_ref, data.args[1]);
    assert.equal(record.attested_at_utc, now.toISOString());
    const verified = security.attestOrVerify('verify', data.args, data.repoRoot, now, data.fetch);
    assert.deepEqual(verified, created);
    assert.deepEqual(data.calls, [[repository, 42], [repository, 42]]);
    assert.deepEqual(fs.readFileSync(created.evidencePath), evidenceBytes);
});

test('security attest rejects replacing an existing evidence file', (t) => {
    const data = lifecycleFixture(t);
    const created = security.attestOrVerify('attest', [...data.args, '42'], data.repoRoot, now, data.fetch);
    const original = fs.readFileSync(created.evidencePath);
    assert.throws(() => security.attestOrVerify('attest', [...data.args, '42'], data.repoRoot, now, data.fetch),
        (error: unknown) => (error as NodeJS.ErrnoException).code === 'EEXIST');
    assert.deepEqual(fs.readFileSync(created.evidencePath), original);
});

test('security verify rejects missing malformed and missing-run-ID evidence before fetch', (t) => {
    const data = lifecycleFixture(t);
    const evidencePath = path.join(data.directory, 'security-evidence.json');
    assert.throws(() => security.attestOrVerify('verify', data.args, data.repoRoot, now, data.fetch),
        (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT');
    fs.writeFileSync(evidencePath, '{broken');
    assert.throws(() => security.attestOrVerify('verify', data.args, data.repoRoot, now, data.fetch), SyntaxError);
    fs.writeFileSync(evidencePath, JSON.stringify({ security: {}, attested_at_utc: now.toISOString() }));
    assert.throws(() => security.attestOrVerify('verify', data.args, data.repoRoot, now, data.fetch), /run ID is missing/);
    assert.deepEqual(data.calls, []);
});

test('security verify rejects replaced candidate binding without overwriting the record', (t) => {
    const data = lifecycleFixture(t);
    const created = security.attestOrVerify('attest', [...data.args, '42'], data.repoRoot, now, data.fetch);
    const record = JSON.parse(fs.readFileSync(created.evidencePath, 'utf8'));
    record.candidate.tarball_sha256 = 'd'.repeat(64);
    const altered = JSON.stringify(record);
    fs.writeFileSync(created.evidencePath, altered);
    assert.throws(() => security.attestOrVerify('verify', data.args, data.repoRoot, now, data.fetch), /different candidate/);
    assert.equal(fs.readFileSync(created.evidencePath, 'utf8'), altered);
});

test('security verify rejects the obsolete normalized workflow digest without overwriting', (t) => {
    const data = lifecycleFixture(t);
    const created = security.attestOrVerify('attest', [...data.args, '42'], data.repoRoot, now, data.fetch);
    const record = JSON.parse(fs.readFileSync(created.evidencePath, 'utf8'));
    assert.equal(record.security.workflow_sha256, '6052f5d04a1eae574aae2e7236d424c7f4e48a8aedcd39ae6cf4220f24d83ed5');
    record.security.workflow_sha256 = '75df431f6967c0613af98b0dab944491e1a5cd07294be7fa0013a42ae0e0e139';
    const altered = JSON.stringify(record);
    fs.writeFileSync(created.evidencePath, altered);
    assert.throws(() => security.attestOrVerify('verify', data.args, data.repoRoot, now, data.fetch),
        /Security evidence is absent, altered, stale, or bound to a different candidate/);
    assert.equal(fs.readFileSync(created.evidencePath, 'utf8'), altered);
});

test('security verify rejects legacy schema and missing or altered scan bindings without overwriting', (t) => {
    const data = lifecycleFixture(t);
    const created = security.attestOrVerify('attest', [...data.args, '42'], data.repoRoot, now, data.fetch);
    const original = JSON.parse(fs.readFileSync(created.evidencePath, 'utf8')) as {
        schema_version?: number; security: Record<string, unknown>;
    };
    const mutations = [
        (record: typeof original) => { record.schema_version = 1; },
        (record: typeof original) => { delete record.schema_version; },
        (record: typeof original) => { delete record.security.selector_sha256; },
        (record: typeof original) => { record.security.selector_sha256 = 'd'.repeat(64); },
        (record: typeof original) => { delete record.security.osv_checkout_ref; },
        (record: typeof original) => { record.security.osv_checkout_ref = 'd'.repeat(40); },
        (record: typeof original) => {
            record.schema_version = 1;
            delete record.security.selector_sha256;
            delete record.security.osv_checkout_ref;
        }
    ];
    for (const mutate of mutations) {
        const record = structuredClone(original);
        mutate(record);
        const altered = JSON.stringify(record);
        fs.writeFileSync(created.evidencePath, altered);
        assert.throws(() => security.attestOrVerify('verify', data.args, data.repoRoot, now, data.fetch),
            /Security evidence is absent, altered, stale, or bound to a different candidate/);
        assert.equal(fs.readFileSync(created.evidencePath, 'utf8'), altered);
    }
});

test('security verify rejects stale future and pre-scan attestations with a fresh scan', (t) => {
    const data = lifecycleFixture(t);
    const created = security.attestOrVerify('attest', [...data.args, '42'], data.repoRoot, now, data.fetch);
    const original = JSON.parse(fs.readFileSync(created.evidencePath, 'utf8'));
    for (const attestedAt of [new Date(now.getTime() - security.MAX_EVIDENCE_AGE_MS - 1).toISOString(),
        new Date(now.getTime() + 10 * 60 * 1000).toISOString(), '2026-09-25T10:19:59.000Z']) {
        fs.writeFileSync(created.evidencePath, JSON.stringify({ ...original, attested_at_utc: attestedAt }));
        assert.throws(() => security.attestOrVerify('verify', data.args, data.repoRoot, now, data.fetch),
            /attestation is stale or predates the scan/, attestedAt);
    }
});

test('security verify rejects replaced live jobs and a missing successful scan', (t) => {
    const data = lifecycleFixture(t);
    const created = security.attestOrVerify('attest', [...data.args, '42'], data.repoRoot, now, data.fetch);
    const original = fs.readFileSync(created.evidencePath);
    data.payload.jobs.jobs[0].id = 999;
    assert.throws(() => security.attestOrVerify('verify', data.args, data.repoRoot, now, data.fetch), /different candidate/);
    data.payload.jobs.jobs[0].id = 101;
    data.payload.run.conclusion = 'failure';
    assert.throws(() => security.attestOrVerify('verify', data.args, data.repoRoot, now, data.fetch), /missing, skipped, failed/);
    assert.deepEqual(fs.readFileSync(created.evidencePath), original);
    assert.equal(data.calls.length, 3);
});

test('security attest fails closed on fetch failure and an invalid run ID', (t) => {
    const data = lifecycleFixture(t);
    const unavailable = () => { throw new Error('Fixture GitHub API unavailable'); };
    assert.throws(() => security.attestOrVerify('attest', [...data.args, '42'], data.repoRoot, now, unavailable),
        /Fixture GitHub API unavailable/);
    assert.equal(fs.existsSync(path.join(data.directory, 'security-evidence.json')), false);
    assert.throws(() => security.attestOrVerify('attest', [...data.args, 'not-an-id'], data.repoRoot, now, data.fetch),
        /run ID is missing or invalid/);
    assert.deepEqual(data.calls, []);
});
