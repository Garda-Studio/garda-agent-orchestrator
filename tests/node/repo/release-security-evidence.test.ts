import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as childProcess from 'node:child_process';
import * as path from 'node:path';

const security = require(path.join(process.cwd(), 'scripts/release-security-evidence.cjs')) as {
    assertSecurityWorkflow: (content: string) => void;
    validateSecurityRun: (run: object, jobs: object, expected: object, now: Date) => object;
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
        event: 'push',
        status: 'completed',
        conclusion: 'success',
        run_attempt: 1,
        run_started_at: '2026-09-25T10:00:00Z',
        updated_at: '2026-09-25T10:20:00Z'
    };
    const auditJob = {
        id: 101,
        run_id: 42,
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
    return { run, jobs: { total_count: 2, jobs: [auditJob, osvJob] } };
}

test('security evidence accepts only the successful full-graph npm and OSV run', () => {
    const { run, jobs } = fixture();
    assert.deepEqual(security.validateSecurityRun(run, jobs, expected, now), {
        run_id: 42,
        run_attempt: 1,
        run_event: 'push',
        run_completed_at_utc: '2026-09-25T10:20:00Z',
        audit_job_id: 101,
        osv_job_ids: [102]
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
        (jobs: ReturnType<typeof fixture>['jobs']) => { jobs.total_count = 3; },
        (jobs: ReturnType<typeof fixture>['jobs']) => { jobs.jobs[0].head_sha = 'b'.repeat(40); },
        (jobs: ReturnType<typeof fixture>['jobs']) => { jobs.jobs[0].conclusion = 'skipped'; },
        (jobs: ReturnType<typeof fixture>['jobs']) => { jobs.jobs[0].steps[2].conclusion = 'skipped'; },
        (jobs: ReturnType<typeof fixture>['jobs']) => { jobs.jobs[1].steps[1].conclusion = 'skipped'; },
        (jobs: ReturnType<typeof fixture>['jobs']) => { jobs.jobs[1].steps[2].conclusion = 'skipped'; },
        (jobs: ReturnType<typeof fixture>['jobs']) => { jobs.jobs.pop(); jobs.total_count = 1; }
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