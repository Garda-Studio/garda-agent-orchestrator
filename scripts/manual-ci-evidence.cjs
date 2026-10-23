'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const CI_WORKFLOW_SHA256 = 'ae6c9ec689175f147cf8f4fb7d0105fa5684064f9d7fb83b148b1d350e015f36';
const SELECTOR_SHA256 = 'cb34c3544940e746ad023a8fa4c9e6de4b789fec05e1cdef106bbb7c0da034a5';
// Accepted common-baseline scripts, including the current coverage commands.
const CI_SCRIPTS_SHA256 = '10f4cd246af8267427af4e3510469c2eb7566718d7936db956215ca803ad3d19';
const MAX_EVIDENCE_BYTES = 16 * 1024 * 1024;
const MAX_EVIDENCE_AGE_MS = 24 * 60 * 60 * 1000;
const CLOCK_SKEW_MS = 5 * 60 * 1000;
const SKIPPED_MATRIX_FAMILIES = new Map([
    ...['Static Checks', 'Unit Tests', 'Gate Tests', 'CLI Tests', 'Lifecycle Tests', 'Binary Tests']
        .map(name => [name + ' / Node ${{ matrix.node-version }}', name]),
    ...['Release Validation', 'Smoke']
        .map(name => [name + ' / ${{ matrix.os }} / Node ${{ matrix.node-version }}', name])
]);

function sha256(bytes) {
    return crypto.createHash('sha256').update(bytes).digest('hex');
}

function workflowContractSha256(content) {
    // GitHub expressions expand inside run scalars before shell comment parsing.
    return sha256(content.replace(/\r\n/gu, '\n'));
}

function readRegularFile(file) {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_EVIDENCE_BYTES) {
        throw new Error('CI contract input must be a bounded regular file.');
    }
    return fs.readFileSync(file);
}

function record(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid CI evidence object.');
    return value;
}

function assertCiContract(repoRoot, checkScripts = true) {
    const workflow = readRegularFile(path.join(repoRoot, '.github/workflows/ci.yml')).toString('utf8');
    if (workflowContractSha256(workflow) !== CI_WORKFLOW_SHA256 ||
        sha256(readRegularFile(path.join(repoRoot, 'scripts/manual-workflow-authorization.cjs'))) !== SELECTOR_SHA256) {
        throw new Error('CI workflow or selector differs from the reviewed manual complete-suite contract.');
    }
    if (checkScripts) {
        const scripts = record(record(JSON.parse(readRegularFile(path.join(repoRoot, 'package.json')).toString('utf8'))).scripts);
        const digest = sha256(JSON.stringify(Object.entries(scripts).sort(([a], [b]) => a.localeCompare(b, 'en'))));
        if (digest !== CI_SCRIPTS_SHA256) throw new Error('CI npm scripts differ from the reviewed complete-suite contract.');
    }
}

function requiredCiJobs() {
    const jobs = new Map([['Authorize CI selection', ['Authorize selected jobs']]]);
    for (const node of ['22.13.0', '24']) {
        for (const [name, step] of [
            ['Static Checks', 'Run typecheck'], ['Unit Tests', 'Run unit tests'],
            ['Gate Tests', 'Run gate tests (parallel shards)'], ['CLI Tests', 'Run CLI tests (parallel shards)'],
            ['Lifecycle Tests', 'Run lifecycle tests'], ['Binary Tests', 'Run binary tests']
        ]) jobs.set(name + ' / Node ' + node, ['Install dependencies', ...(name === 'Static Checks'
            ? ['Validate workflow references', step, 'Run lint'] : name === 'Unit Tests'
                ? ['Install ripgrep for compact integration tests', 'Build node-foundation', step]
                : ['Build node-foundation', step])]);
        for (const os of ['ubuntu-latest', 'windows-latest']) jobs.set('Release Validation / ' + os + ' / Node ' + node, [
            'Install dependencies',
            'Install ripgrep for compact integration tests (' + (os === 'ubuntu-latest' ? 'Linux' : 'Windows') + ')',
            'Prepare embedded release bundle', 'Bootstrap embedded release bundle', 'Validate release'
        ]);
        for (const os of ['ubuntu-latest', 'windows-latest', 'macos-latest']) jobs.set('Smoke / ' + os + ' / Node ' + node, [
            'Install dependencies', 'Build', 'Build staged node-foundation test graph', 'Pack and install smoke test',
            'Lifecycle smoke (cross-platform E2E install → update → uninstall)'
        ]);
    }
    return jobs;
}

function recentTimestamp(value, now) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u.test(value)) {
        throw new Error('CI evidence timestamp is missing or invalid.');
    }
    const timestamp = Date.parse(value);
    if (!Number.isFinite(timestamp) || timestamp > now.getTime() + CLOCK_SKEW_MS || now.getTime() - timestamp > MAX_EVIDENCE_AGE_MS) {
        throw new Error('CI evidence is stale or in the future.');
    }
    return timestamp;
}

function assertRunIdentity(run, request) {
    if (run.id !== request.ciRunId || run.head_sha !== request.commit || record(run.repository).full_name !== request.repository) {
        throw new Error('CI run belongs to another run, repository or candidate commit.');
    }
    if (!['dev', 'main', 'master'].includes(run.head_branch) || run.event !== 'workflow_dispatch' ||
        !['.github/workflows/ci.yml', '.github/workflows/ci.yml@' + run.head_branch].includes(run.path)) {
        throw new Error('CI run is not a manually authorized release-lane workflow.');
    }
    if (run.status !== 'completed' || !Number.isSafeInteger(run.run_attempt) || run.run_attempt < 1) {
        throw new Error('CI run is incomplete or has an invalid attempt.');
    }
}

function runTimeline(run, now) {
    const started = recentTimestamp(run.run_started_at, now);
    const completed = recentTimestamp(run.updated_at, now);
    if (started > completed) throw new Error('CI run timeline is inconsistent.');
    return { started, completed };
}

function readJobsPayload(payload) {
    const pages = (Array.isArray(payload) ? payload : [payload]).map(record);
    if (!pages.length || pages.some(page => !Array.isArray(page.jobs))) throw new Error('CI jobs evidence is missing.');
    const jobs = pages.flatMap(page => page.jobs).map(record);
    if (!jobs.length || jobs.length > 1000 || !Number.isSafeInteger(pages[0].total_count) ||
        pages.some(page => page.total_count !== jobs.length)) throw new Error('CI job history is incomplete or unbounded.');
    return jobs;
}

function assertJobIdentity(job, run, required, ids) {
    if (!Number.isSafeInteger(job.id) || job.id <= 0 || ids.has(job.id) ||
        job.run_id !== run.id || job.head_sha !== run.head_sha) throw new Error('CI job identity is duplicate or foreign.');
    if ((!required.has(job.name) && !SKIPPED_MATRIX_FAMILIES.has(job.name)) ||
        !Number.isSafeInteger(job.run_attempt) || job.run_attempt < 1 ||
        job.run_attempt > run.run_attempt) throw new Error('CI job name or attempt is invalid.');
}

function latestJobs(jobs, run, required) {
    const latest = new Map(), ids = new Set(), attempts = new Set(), skipped = [];
    for (const job of jobs) {
        assertJobIdentity(job, run, required, ids);
        const key = job.name + ':' + job.run_attempt;
        if (attempts.has(key)) throw new Error('CI history repeats a job in the same attempt.');
        ids.add(job.id); attempts.add(key);
        if (SKIPPED_MATRIX_FAMILIES.has(job.name)) {
            if (job.status !== 'completed' || job.conclusion !== 'skipped' || job.run_attempt >= run.run_attempt ||
                !Array.isArray(job.steps) || job.steps.length !== 0) {
                throw new Error('CI unexpanded matrix record is not an earlier skipped job without execution.');
            }
            skipped.push(job);
            continue;
        }
        if (!latest.has(job.name) || latest.get(job.name).run_attempt < job.run_attempt) latest.set(job.name, job);
    }
    if (latest.size !== required.size || ![...latest.values()].some(job => job.run_attempt === run.run_attempt)) {
        throw new Error('CI complete suite is missing jobs or replays only old attempts.');
    }
    for (const job of skipped) {
        const family = SKIPPED_MATRIX_FAMILIES.get(job.name);
        if ([...required.keys()].filter(name => name.startsWith(family + ' / '))
            .some(name => latest.get(name).run_attempt <= job.run_attempt)) {
            throw new Error('CI skipped matrix family was not fully superseded by later execution.');
        }
    }
    return { latest, skipped };
}

function attemptTimelines(latest, skipped, run, request, endpoint, now, fetch) {
    const current = runTimeline(run, now), timelines = new Map([[run.run_attempt, current]]);
    for (const attempt of new Set([...latest.values(), ...skipped].map(job => job.run_attempt))) {
        if (timelines.has(attempt)) continue;
        const prior = record(fetch(endpoint + '/attempts/' + attempt));
        assertRunIdentity(prior, request);
        if (prior.run_attempt !== attempt || prior.head_branch !== run.head_branch) throw new Error('CI attempt metadata is foreign or replayed.');
        const timeline = runTimeline(prior, now);
        timelines.set(attempt, timeline);
    }
    const ordered = [...timelines.entries()].sort(([left], [right]) => left - right).map(([, timeline]) => timeline);
    for (let index = 1; index < ordered.length; index += 1) {
        const previous = ordered[index - 1], next = ordered[index];
        if (previous.started > next.started || previous.completed > next.completed ||
            previous.completed > next.started + CLOCK_SKEW_MS) {
            throw new Error('CI attempt timelines are reversed or overlapping.');
        }
    }
    return timelines;
}

function assertSuccessfulSteps(job, required) {
    if (!Array.isArray(job.steps)) throw new Error('CI job steps are missing.');
    const steps = job.steps.map(record);
    if (steps.some(step => step.status !== 'completed' || !['success', 'skipped'].includes(step.conclusion))) {
        throw new Error('CI job contains a failed or incomplete step.');
    }
    for (const name of required) {
        if (steps.filter(step => step.name === name && step.status === 'completed' && step.conclusion === 'success').length !== 1) {
            throw new Error('CI job lacks a successful required step: ' + name);
        }
    }
}

function assertJobTimeline(job, timeline, now) {
    const started = recentTimestamp(job.started_at, now), completed = recentTimestamp(job.completed_at, now);
    if (started < timeline.started - CLOCK_SKEW_MS || started > completed || completed > timeline.completed + CLOCK_SKEW_MS) {
        throw new Error('CI job timeline differs from its authenticated attempt.');
    }
}

function assertSuccessfulJob(job, required, timeline, now) {
    if (job.status !== 'completed' || job.conclusion !== 'success') throw new Error('Latest CI matrix job did not succeed without skipping.');
    assertJobTimeline(job, timeline, now);
    assertSuccessfulSteps(job, required);
}

function verifyCiEvidence(repoRoot, request, now, fetch) {
    if (!/^[a-f0-9]{40}$/u.test(request.commit) || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(request.repository) ||
        !Number.isSafeInteger(request.ciRunId) || request.ciRunId <= 0 || !(now instanceof Date) || !Number.isFinite(now.getTime())) {
        throw new Error('Invalid CI verification identity or time.');
    }
    assertCiContract(repoRoot);
    const endpoint = 'repos/' + request.repository + '/actions/runs/' + request.ciRunId;
    const run = record(fetch(endpoint));
    assertRunIdentity(run, request);
    if (run.conclusion !== 'success') throw new Error('Current CI workflow run did not succeed.');
    const required = requiredCiJobs();
    const { latest, skipped } = latestJobs(readJobsPayload(fetch(endpoint + '/jobs?filter=all&per_page=100', true)), run, required);
    const timelines = attemptTimelines(latest, skipped, run, request, endpoint, now, fetch);
    for (const job of skipped) assertJobTimeline(job, timelines.get(job.run_attempt), now);
    for (const [name, job] of latest) assertSuccessfulJob(job, required.get(name), timelines.get(job.run_attempt), now);
    return { run_id: run.id, run_attempt: run.run_attempt, commit: run.head_sha,
        verified_jobs: latest.size, attempts: [...timelines.keys()].sort((a, b) => a - b) };
}

module.exports = { assertCiContract, requiredCiJobs, verifyCiEvidence, workflowContractSha256 };
