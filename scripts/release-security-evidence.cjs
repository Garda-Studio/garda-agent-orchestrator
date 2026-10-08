'use strict';

const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { verifyManifest } = require('./release-candidate.cjs');

const SECURITY_WORKFLOW_SHA256 = '6052f5d04a1eae574aae2e7236d424c7f4e48a8aedcd39ae6cf4220f24d83ed5';
const SELECTOR_SHA256 = 'cb34c3544940e746ad023a8fa4c9e6de4b789fec05e1cdef106bbb7c0da034a5';
const OSV_ACTION_REF = 'google/osv-scanner-action/.github/workflows/osv-scanner-reusable.yml@b77c075a1235514558f0eb88dbd31e22c45e0cd2';
const MAX_EVIDENCE_AGE_MS = 24 * 60 * 60 * 1000;
const CLOCK_SKEW_MS = 5 * 60 * 1000;
const MAX_EVIDENCE_BYTES = 16 * 1024 * 1024;
const COMMIT_RE = /^[a-f0-9]{40}$/u;
const SHA256_RE = /^[a-f0-9]{64}$/u;
const REPOSITORY_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const OSV_JOB_NAME = 'OSV Vulnerability Scan / osv-scan';
const REQUIRED_JOBS = new Map([
    ['Authorize Security selection', ['Authorize selected jobs']],
    ['npm audit', ['Pin release audit npm CLI', 'Install dependencies', 'Audit dependencies']],
    [OSV_JOB_NAME, ['Run scanner', 'Run osv-scanner-reporter']]
]);

function fail(message) {
    throw new Error(message);
}

function sha256(data) {
    return crypto.createHash('sha256').update(data).digest('hex');
}

function workflowContractSha256(content) {
    // Retain scalar comments, whitespace and expressions as reviewed source bytes.
    return sha256(content.replace(/\r\n/gu, '\n'));
}

function readContractFile(file) {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_EVIDENCE_BYTES) {
        fail('Security contract input must be a bounded regular file.');
    }
    return fs.readFileSync(file);
}

function assertSecurityWorkflow(content, selector = readContractFile(path.join(__dirname, 'manual-workflow-authorization.cjs'))) {
    if (workflowContractSha256(content) !== SECURITY_WORKFLOW_SHA256 || sha256(selector) !== SELECTOR_SHA256) {
        fail('Security workflow or selector differs from the reviewed manually authorized audit and OSV contract.');
    }
}

function timestamp(value, label) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u.test(value)) {
        fail(label + ' timestamp is missing or invalid.');
    }
    const result = Date.parse(value);
    if (!Number.isFinite(result)) {
        fail(label + ' timestamp is missing or invalid.');
    }
    return result;
}

function assertRecent(completedAt, nowMs, label) {
    const completedMs = timestamp(completedAt, label);
    if (completedMs > nowMs + CLOCK_SKEW_MS || nowMs - completedMs > MAX_EVIDENCE_AGE_MS) {
        fail(label + ' evidence is stale or in the future.');
    }
    return completedMs;
}

function readJobsPayload(payload) {
    const pages = Array.isArray(payload) ? payload : [payload];
    if (pages.length === 0 || pages.some((page) => !page || !Array.isArray(page.jobs))) {
        fail('Security workflow jobs evidence is missing.');
    }
    const jobs = pages.flatMap((page) => page.jobs);
    if (!Number.isSafeInteger(pages[0].total_count) || pages.some(page => page.total_count !== jobs.length) ||
        jobs.length === 0 || jobs.length > 1000) {
        fail('Security workflow jobs evidence is incomplete.');
    }
    return jobs;
}

function isReleaseBranch(branch) {
    if (typeof branch !== 'string') {
        return false;
    }
    if (['dev', 'main', 'master'].includes(branch)) {
        return true;
    }
    if (!branch.startsWith('release/')) {
        return false;
    }
    const result = childProcess.spawnSync('git', ['check-ref-format', '--branch', branch], {
        encoding: 'utf8',
        windowsHide: true,
        maxBuffer: 1024 * 1024
    });
    return !result.error && result.status === 0;
}

function assertRunIdentity(run, expected) {
    if (run?.id !== expected.runId || run.head_sha !== expected.commit ||
        run.repository?.full_name !== expected.repository ||
        !['.github/workflows/security.yml', '.github/workflows/security.yml@' + run.head_branch].includes(run.path) ||
        !isReleaseBranch(run.head_branch) ||
        run.event !== 'workflow_dispatch' || run.status !== 'completed' ||
        !Number.isSafeInteger(run.run_attempt) || run.run_attempt < 1) {
        fail('Security workflow run is missing, skipped, failed, or for another release commit.');
    }
}

function runTimeline(run, nowMs) {
    const startedMs = assertRecent(run.run_started_at, nowMs, 'Security run start');
    const completedMs = assertRecent(run.updated_at, nowMs, 'Security run completion');
    if (startedMs > completedMs) {
        fail('Security workflow run timeline is inconsistent.');
    }

    return { startedMs, completedMs };
}

function latestJobs(jobs, run, expected) {
    const latest = new Map(), ids = new Set(), namesAndAttempts = new Set(), skipped = [];
    for (const job of jobs) {
        if (!Number.isSafeInteger(job?.id) || job.id <= 0 || ids.has(job.id) ||
            job.run_id !== run.id || job.head_sha !== expected.commit ||
            !Number.isSafeInteger(job.run_attempt) || job.run_attempt < 1 || job.run_attempt > run.run_attempt) {
            fail('Security job identity or attempt is duplicate, invalid, or foreign.');
        }
        const key = job.name + ':' + job.run_attempt;
        if (namesAndAttempts.has(key)) fail('Security history repeats a job in the same attempt.');
        ids.add(job.id); namesAndAttempts.add(key);
        // GitHub can retain a caller-level name when its reusable job never expanded.
        // It adds no scan coverage and must be superseded by the pinned inner job.
        if (job.name === 'OSV Vulnerability Scan') {
            if (job.status !== 'completed' || job.conclusion !== 'skipped' || job.run_attempt >= run.run_attempt ||
                !Array.isArray(job.steps) || job.steps.length !== 0) fail('Security reusable placeholder is not an earlier skipped job without execution.');
            skipped.push(job);
        } else {
            if (!REQUIRED_JOBS.has(job.name)) fail('Security history contains an unreviewed job name.');
            if (!latest.has(job.name) || latest.get(job.name).run_attempt < job.run_attempt) latest.set(job.name, job);
        }
    }
    if (latest.size !== REQUIRED_JOBS.size || ![...latest.values()].some(job => job.run_attempt === run.run_attempt) ||
        skipped.some(job => latest.get(OSV_JOB_NAME).run_attempt <= job.run_attempt)) {
        fail('Security complete authorization, audit and OSV coverage is missing or replays old attempts.');
    }
    return latest;
}

function attemptTimelines(jobs, run, expected, nowMs, fetchAttempt) {
    const timelines = new Map([[run.run_attempt, runTimeline(run, nowMs)]]);
    for (const attempt of new Set(jobs.map(job => job.run_attempt))) {
        if (timelines.has(attempt)) continue;
        if (typeof fetchAttempt !== 'function') fail('Authenticated Security attempt metadata is missing.');
        const prior = fetchAttempt(attempt);
        assertRunIdentity(prior, expected);
        if (prior.run_attempt !== attempt || prior.head_branch !== run.head_branch) fail('Security attempt metadata is foreign or replayed.');
        timelines.set(attempt, runTimeline(prior, nowMs));
    }
    const ordered = [...timelines].sort(([left], [right]) => left - right).map(([, timeline]) => timeline);
    for (let index = 1; index < ordered.length; index += 1) {
        const previous = ordered[index - 1], next = ordered[index];
        if (previous.startedMs > next.startedMs || previous.completedMs > next.completedMs ||
            previous.completedMs > next.startedMs + CLOCK_SKEW_MS) fail('Security attempt timelines are reversed or overlapping.');
    }
    return timelines;
}

function assertJobTimeline(job, timeline, nowMs) {
    const started = assertRecent(job.started_at, nowMs, 'Security job start');
    const completed = assertRecent(job.completed_at, nowMs, 'Security job completion');
    if (job.status !== 'completed' || started < timeline.startedMs - CLOCK_SKEW_MS ||
        started > completed || completed > timeline.completedMs + CLOCK_SKEW_MS) {
        fail('Security job timeline differs from its authenticated attempt.');
    }
}

function assertSuccessfulJob(job, requiredSteps) {
    if (job.conclusion !== 'success' || !Array.isArray(job.steps) ||
        job.steps.some(step => step?.status !== 'completed' || !['success', 'skipped'].includes(step.conclusion))) {
        fail('Latest Security job or step is skipped, failed, or incomplete.');
    }
    for (const name of requiredSteps) {
        if (job.steps.filter(step => step.name === name && step.conclusion === 'success').length !== 1) {
            fail('Security job lacks a successful required step: ' + name);
        }
    }
}

function validateSecurityRun(run, jobsPayload, expected, now = new Date(), fetchAttempt) {
    const nowMs = now instanceof Date ? now.getTime() : NaN;
    if (!Number.isFinite(nowMs) || !COMMIT_RE.test(expected?.commit) || !REPOSITORY_RE.test(expected?.repository) ||
        !Number.isSafeInteger(expected?.runId) || expected.runId <= 0) fail('Security evidence request identity is invalid.');
    assertRunIdentity(run, expected);
    if (run.conclusion !== 'success') fail('Security workflow run is missing, skipped, failed, or for another release commit.');
    const jobs = readJobsPayload(jobsPayload);
    const latest = latestJobs(jobs, run, expected);
    const timelines = attemptTimelines(jobs, run, expected, nowMs, fetchAttempt);
    for (const job of jobs) {
        assertJobTimeline(job, timelines.get(job.run_attempt), nowMs);
    }
    for (const [name, steps] of REQUIRED_JOBS) assertSuccessfulJob(latest.get(name), steps);
    return {
        run_id: run.id,
        run_attempt: run.run_attempt,
        run_event: run.event,
        run_completed_at_utc: run.updated_at,
        authorization_job_id: latest.get('Authorize Security selection').id,
        audit_job_id: latest.get('npm audit').id,
        osv_job_ids: [latest.get(OSV_JOB_NAME).id],
        job_attempts: [...REQUIRED_JOBS.keys()].map(name => ({ name, id: latest.get(name).id, attempt: latest.get(name).run_attempt }))
    };
}

function assertDevGraph(packageJson, lockfile) {
    const declared = packageJson?.devDependencies;
    const locked = lockfile?.packages?.['']?.devDependencies;
    if (!declared || !locked || typeof declared !== 'object' || typeof locked !== 'object' ||
        !Object.keys(declared).includes('@cyclonedx/cyclonedx-npm') ||
        JSON.stringify(Object.entries(declared).sort()) !== JSON.stringify(Object.entries(locked).sort())) {
        fail('Root lockfile does not bind the complete development and release-tool dependency graph.');
    }
}

function runGit(repoRoot, args) {
    const result = childProcess.spawnSync('git', args, {
        cwd: repoRoot,
        encoding: 'utf8',
        windowsHide: true,
        maxBuffer: 1024 * 1024
    });
    if (result.error || result.status !== 0) {
        fail('Cannot verify the clean release candidate checkout.');
    }
    return result.stdout.trim();
}

function readCandidateContext(repoRoot, candidateDirectory, commit, tag, tarballSha256, tarballName, repository) {
    if (!path.isAbsolute(candidateDirectory) || !COMMIT_RE.test(commit) || !SHA256_RE.test(tarballSha256) ||
        !REPOSITORY_RE.test(repository) || typeof tarballName !== 'string') {
        fail('Release candidate evidence identity is invalid.');
    }
    if (runGit(repoRoot, ['rev-parse', 'HEAD']) !== commit ||
        runGit(repoRoot, ['status', '--porcelain', '--untracked-files=all']) !== '') {
        fail('Release candidate checkout is not clean at the evidence commit.');
    }
    verifyManifest(candidateDirectory, commit, tag, tarballSha256, tarballName);
    const manifest = JSON.parse(fs.readFileSync(path.join(candidateDirectory, 'candidate-manifest.json'), 'utf8'));
    const lockfileBytes = fs.readFileSync(path.join(repoRoot, 'package-lock.json'));
    const lockfile = JSON.parse(lockfileBytes.toString('utf8'));
    const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    assertDevGraph(packageJson, lockfile);
    assertSecurityWorkflow(readContractFile(path.join(repoRoot, '.github', 'workflows', 'security.yml')).toString('utf8'),
        readContractFile(path.join(repoRoot, 'scripts', 'manual-workflow-authorization.cjs')));
    return {
        commit_sha: commit,
        tag,
        tarball_name: manifest.tarball_name,
        tarball_sha256: manifest.tarball_sha256,
        lockfile_sha256: sha256(lockfileBytes),
        repository
    };
}

function createEvidence(candidate, security, attestedAtUtc) {
    timestamp(attestedAtUtc, 'Attestation');
    return {
        schema_version: 2,
        source: 'authenticated_github_actions_api',
        candidate,
        security: {
            ...security,
            workflow_sha256: SECURITY_WORKFLOW_SHA256,
            selector_sha256: SELECTOR_SHA256,
            node_version: '24',
            npm_cli_version: '11.15.0',
            npm_audit_registry: 'https://registry.npmjs.org',
            npm_install_ignore_scripts: true,
            npm_audit_lockfile_only: true,
            npm_audit_scope: 'all_dependencies_including_dev',
            npm_audit_policy: 'high_or_critical_blocking',
            osv_action_ref: OSV_ACTION_REF,
            osv_checkout_ref: candidate.commit_sha,
            osv_scan_args: '--lockfile=package-lock.json',
            osv_fail_on_vuln: true
        },
        attested_at_utc: attestedAtUtc
    };
}

function assertEvidenceMatches(recorded, current) {
    if (JSON.stringify(recorded) !== JSON.stringify(current)) {
        fail('Security evidence is absent, altered, stale, or bound to a different candidate.');
    }
}

function ghApiJson(endpoint, paginate = false) {
    const args = ['api', '--hostname', 'github.com', endpoint];
    if (paginate) {
        args.push('--paginate', '--slurp');
    }
    const result = childProcess.spawnSync('gh', args, {
        encoding: 'utf8',
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024
    });
    if (result.error || result.status !== 0) {
        fail('Authenticated GitHub security-run evidence is unavailable.');
    }
    try {
        return JSON.parse(result.stdout);
    } catch {
        fail('Authenticated GitHub security-run response is invalid JSON.');
    }
}

function fetchSecurityRun(repository, runId) {
    const endpoint = 'repos/' + repository + '/actions/runs/' + runId;
    const run = ghApiJson(endpoint);
    const jobs = ghApiJson(endpoint + '/jobs?filter=all&per_page=100', true);
    return { run, jobs, fetchAttempt: attempt => ghApiJson(endpoint + '/attempts/' + attempt) };
}

function attestOrVerify(mode, argv, repoRoot = process.cwd(), now = new Date(), fetch = fetchSecurityRun) {
    const expectedArgCount = mode === 'attest' ? 7 : 6;
    if (argv.length !== expectedArgCount) {
        fail('Usage: release-security-evidence.cjs <attest|verify> <candidate-dir> <commit> <tag> <sha256> <tarball-name> <owner/repo> [security-run-id]');
    }
    const [candidateDirectory, commit, tag, tarballSha256, tarballName, repository] = argv;
    const candidate = readCandidateContext(repoRoot, candidateDirectory, commit, tag, tarballSha256, tarballName, repository);
    const evidencePath = path.join(candidateDirectory, 'security-evidence.json');
    const recorded = mode === 'verify' ? JSON.parse(fs.readFileSync(evidencePath, 'utf8')) : null;
    const runId = mode === 'attest' ? Number(argv[6]) : recorded?.security?.run_id;
    if (!Number.isSafeInteger(runId) || runId <= 0) {
        fail('Security workflow run ID is missing or invalid.');
    }
    const payload = fetch(repository, runId);
    const security = validateSecurityRun(payload.run, payload.jobs, { commit, repository, runId }, now, payload.fetchAttempt);
    const attestedAtUtc = mode === 'attest' ? now.toISOString() : recorded?.attested_at_utc;
    const attestedMs = timestamp(attestedAtUtc, 'Attestation');
    if (attestedMs > now.getTime() + CLOCK_SKEW_MS ||
        now.getTime() - attestedMs > MAX_EVIDENCE_AGE_MS ||
        attestedMs < timestamp(security.run_completed_at_utc, 'Security run completion')) {
        fail('Candidate-bound security attestation is stale or predates the scan.');
    }
    const current = createEvidence(candidate, security, attestedAtUtc);
    if (mode === 'attest') {
        fs.writeFileSync(evidencePath, JSON.stringify(current, null, 2) + '\n', { flag: 'wx' });
        return { evidencePath, evidenceSha256: sha256(fs.readFileSync(evidencePath)) };
    }
    assertEvidenceMatches(recorded, current);
    return { evidencePath, evidenceSha256: sha256(fs.readFileSync(evidencePath)) };
}

function main(argv) {
    const [mode, ...args] = argv;
    if (!['attest', 'verify'].includes(mode)) {
        fail('Usage: release-security-evidence.cjs <attest|verify> <candidate-dir> <commit> <tag> <sha256> <tarball-name> <owner/repo> [security-run-id]');
    }
    const result = attestOrVerify(mode, args);
    process.stdout.write('RELEASE_SECURITY_EVIDENCE_' + (mode === 'attest' ? 'CREATED' : 'VERIFIED') +
        ' sha256=' + result.evidenceSha256 + '\n');
}

if (require.main === module) {
    try {
        main(process.argv.slice(2));
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}

module.exports = {
    SECURITY_WORKFLOW_SHA256,
    OSV_ACTION_REF,
    MAX_EVIDENCE_AGE_MS,
    workflowContractSha256,
    assertSecurityWorkflow,
    readJobsPayload,
    validateSecurityRun,
    assertDevGraph,
    createEvidence,
    assertEvidenceMatches,
    readCandidateContext,
    attestOrVerify
};
