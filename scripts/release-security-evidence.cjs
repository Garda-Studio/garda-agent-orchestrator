'use strict';

const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { verifyManifest } = require('./release-candidate.cjs');

const SECURITY_WORKFLOW_SHA256 = "33fba2f23fa0aefa2b9ff7969dc200510941ab58a108ef90850f3250f6cd80fe";
const OSV_ACTION_REF = 'google/osv-scanner-action/.github/workflows/osv-scanner-reusable.yml@b77c075a1235514558f0eb88dbd31e22c45e0cd2';
const MAX_EVIDENCE_AGE_MS = 24 * 60 * 60 * 1000;
const CLOCK_SKEW_MS = 5 * 60 * 1000;
const COMMIT_RE = /^[a-f0-9]{40}$/u;
const SHA256_RE = /^[a-f0-9]{64}$/u;
const REPOSITORY_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const RELEASE_BRANCH_RE = /^(?:dev|main|master|release\/[A-Za-z0-9_.-]+)$/u;

function fail(message) {
    throw new Error(message);
}

function sha256(data) {
    return crypto.createHash('sha256').update(data).digest('hex');
}

function workflowContractSha256(content) {
    return sha256(content.split(/\r?\n/u)
        .filter((line) => line.trim() !== '' && !line.trimStart().startsWith('#'))
        .map((line) => line.trimEnd())
        .join('\n'));
}

function assertSecurityWorkflow(content) {
    if (workflowContractSha256(content) !== SECURITY_WORKFLOW_SHA256) {
        fail('Security workflow differs from the reviewed all-dependency audit and OSV contract.');
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
    if (!Number.isSafeInteger(pages[0].total_count) || pages[0].total_count !== jobs.length ||
        jobs.length === 0 || jobs.length > 1000) {
        fail('Security workflow jobs evidence is incomplete.');
    }
    return jobs;
}

function assertSuccessfulJob(job, run, commit, nowMs) {
    if (!Number.isSafeInteger(job?.id) || job.id <= 0 || job.run_id !== run.id ||
        job.head_sha !== commit || job.status !== 'completed' || job.conclusion !== 'success') {
        fail('Security workflow job is skipped, failed, or from another run or commit.');
    }
    const startedMs = timestamp(job.started_at, 'Security job start');
    const completedMs = assertRecent(job.completed_at, nowMs, 'Security job completion');
    if (startedMs > completedMs || completedMs > timestamp(run.updated_at, 'Security run update') + CLOCK_SKEW_MS) {
        fail('Security workflow job timeline is inconsistent.');
    }
    if (!Array.isArray(job.steps) || job.steps.length === 0 ||
        job.steps.some((step) => !['success', 'skipped'].includes(step?.conclusion))) {
        fail('Security workflow job has a failed or incomplete step.');
    }
}

function assertAuditSteps(job) {
    for (const name of ['Pin release audit npm CLI', 'Install dependencies', 'Audit dependencies']) {
        if (job.steps.filter((step) => step.name === name &&
            step.status === 'completed' && step.conclusion === 'success').length !== 1) {
            fail('Security npm audit job lacks a successful required step: ' + name);
        }
    }
}

function validateSecurityRun(run, jobsPayload, expected, now = new Date()) {
    const nowMs = now instanceof Date ? now.getTime() : NaN;
    if (!Number.isFinite(nowMs) || !COMMIT_RE.test(expected?.commit) ||
        !REPOSITORY_RE.test(expected?.repository) ||
        !Number.isSafeInteger(expected?.runId) || expected.runId <= 0) {
        fail('Security evidence request identity is invalid.');
    }
    if (run?.id !== expected.runId || run.head_sha !== expected.commit ||
        run.repository?.full_name !== expected.repository ||
        !['.github/workflows/security.yml', '.github/workflows/security.yml@' + run.head_branch].includes(run.path) ||
        !RELEASE_BRANCH_RE.test(run.head_branch || '') ||
        !['push', 'workflow_dispatch'].includes(run.event) ||
        run.status !== 'completed' || run.conclusion !== 'success' ||
        !Number.isSafeInteger(run.run_attempt) || run.run_attempt < 1) {
        fail('Security workflow run is missing, skipped, failed, or for another release commit.');
    }
    const startedMs = timestamp(run.run_started_at, 'Security run start');
    const completedMs = assertRecent(run.updated_at, nowMs, 'Security run completion');
    if (startedMs > completedMs) {
        fail('Security workflow run timeline is inconsistent.');
    }

    const jobs = readJobsPayload(jobsPayload);
    const auditJobs = jobs.filter((job) => job.name === 'npm audit');
    const osvJobs = jobs.filter((job) => job.name === 'OSV Vulnerability Scan' ||
        job.name.startsWith('OSV Vulnerability Scan / '));
    if (auditJobs.length !== 1 || osvJobs.length === 0 ||
        jobs.length !== auditJobs.length + osvJobs.length) {
        fail('Security run does not contain exactly the required full-graph audit and OSV jobs.');
    }
    for (const job of jobs) {
        assertSuccessfulJob(job, run, expected.commit, nowMs);
    }
    assertAuditSteps(auditJobs[0]);
    for (const job of osvJobs) {
        for (const name of ['Run scanner', 'Run osv-scanner-reporter']) {
            if (job.steps.filter((step) => step.name === name &&
                step.status === 'completed' && step.conclusion === 'success').length !== 1) {
                fail('OSV scanner job lacks a successful required step: ' + name);
            }
        }
    }
    return {
        run_id: run.id,
        run_attempt: run.run_attempt,
        run_event: run.event,
        run_completed_at_utc: run.updated_at,
        audit_job_id: auditJobs[0].id,
        osv_job_ids: osvJobs.map((job) => job.id).sort((left, right) => left - right)
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
    assertSecurityWorkflow(fs.readFileSync(path.join(repoRoot, '.github', 'workflows', 'security.yml'), 'utf8'));
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
        schema_version: 1,
        source: 'authenticated_github_actions_api',
        candidate,
        security: {
            ...security,
            workflow_sha256: SECURITY_WORKFLOW_SHA256,
            node_version: '24',
            npm_cli_version: '11.15.0',
            npm_audit_registry: 'https://registry.npmjs.org',
            npm_install_ignore_scripts: true,
            npm_audit_lockfile_only: true,
            npm_audit_scope: 'all_dependencies_including_dev',
            npm_audit_policy: 'high_or_critical_blocking',
            osv_action_ref: OSV_ACTION_REF,
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
    const jobs = ghApiJson(endpoint + '/jobs?per_page=100', true);
    return { run, jobs };
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
    const security = validateSecurityRun(payload.run, payload.jobs, { commit, repository, runId }, now);
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
