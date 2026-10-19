#!/usr/bin/env node
'use strict';

const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { workflowContractSha256 } = require('./manual-ci-evidence.cjs');

// Bind the complete explicitly authorized manual Publish workflow source.
const PUBLISH_SOURCE_SHA256 = '461495504bbb5a33b18bebebe6f7d85873b019b7ae94f35a49b58f5e493527aa';
const SELECTOR_SHA256 = 'cb34c3544940e746ad023a8fa4c9e6de4b789fec05e1cdef106bbb7c0da034a5';
const WORKFLOW = '.github/workflows/publish.yml';
const SELECTOR = 'scripts/manual-workflow-authorization.cjs';
const MAX_ATTEMPTS = 3;
const MAX_PAGES = 10;
const MAX_BYTES = 16 * 1024 * 1024;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const CLOCK_SKEW_MS = 5 * 60 * 1000;
const MAX_TAG_DEPTH = 3;
const AUTH_JOB = 'Authorize publish selection';
const VALIDATE_JOB = 'Validate release package';
const STAGE_JOB = 'Stage package on npm';
const STAGE_STEP = 'Stage the validated tarball with npm Trusted Publishing';
const VALIDATION_STEPS = ['Validate tag and package version', 'Require successful CI for this release commit',
    'Run local release proof', 'Pack and attest release candidate'];
const TERMINAL = ['success', 'failure', 'cancelled', 'timed_out', 'skipped', 'neutral', 'action_required', 'stale'];

function requireCondition(condition, message) {
    if (!condition) throw new Error(message);
}

function record(value) {
    requireCondition(value && typeof value === 'object' && !Array.isArray(value), 'Publish evidence object is missing.');
    return value;
}

function positiveInteger(value) {
    const text = typeof value === 'number' ? String(value) : value;
    requireCondition(typeof text === 'string' && /^[1-9][0-9]*$/u.test(text) && Number.isSafeInteger(Number(text)),
        'Publish identity must be a positive safe integer ID or attempt.');
    return Number(text);
}

function normalizeRequest(input) {
    const request = record(input);
    requireCondition(typeof request.repository === 'string' && /^[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/u.test(request.repository) &&
        !['.', '..'].includes(request.repository.split('/')[1]), 'Publish repository identity is invalid.');
    requireCondition(typeof request.commit === 'string' && /^[a-f0-9]{40}$/u.test(request.commit), 'Publish commit identity is invalid.');
    requireCondition(typeof request.tag === 'string' && request.tag.length <= 128 &&
        /^v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[A-Za-z0-9.-]+)?(?:\+[A-Za-z0-9.-]+)?$/u.test(request.tag),
    'Publish tag identity is invalid.');
    requireCondition(['validate', 'stage-publish'].includes(request.phase), 'Publish guard phase is invalid.');
    return { repository: request.repository, commit: request.commit, tag: request.tag, phase: request.phase,
        runId: positiveInteger(request.runId), runAttempt: positiveInteger(request.runAttempt) };
}

function fetchAuthenticated(endpoint) {
    const result = childProcess.spawnSync('gh', ['api', '--hostname', 'github.com', '--method', 'GET', endpoint], {
        encoding: 'utf8', windowsHide: true, maxBuffer: MAX_BYTES, timeout: 30000
    });
    requireCondition(!result.error && result.status === 0, 'Authenticated GitHub publication evidence is unavailable.');
    try { return JSON.parse(result.stdout); }
    catch { throw new Error('Authenticated GitHub publication evidence is unavailable or malformed.'); }
}

function sameSourceMetadata(left, right) {
    return left.isFile() && right.isFile() && left.ino === right.ino && left.mode === right.mode &&
        left.uid === right.uid && left.gid === right.gid && left.nlink === right.nlink && left.size === right.size &&
        left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs && left.birthtimeMs === right.birthtimeMs;
}

function completeSourcePathIdentity(file, current, flags) {
    if (process.platform !== 'win32' || current.dev !== 0 || !current.isFile()) return current;
    // This guard runs before compilation. Authenticate the omitted Windows
    // volume through a second live descriptor without a compiled dependency.
    const realFile = fs.realpathSync.native(file);
    const descriptor = fs.openSync(file, flags);
    try {
        const identity = fs.fstatSync(descriptor), after = fs.lstatSync(file);
        requireCondition(sameSourceMetadata(current, identity) && sameSourceMetadata(current, after) &&
            current.dev === after.dev && !after.isSymbolicLink() && fs.realpathSync.native(file) === realFile,
        'Publish source identity changed while reading.');
        return identity;
    } finally { fs.closeSync(descriptor); }
}

function readContractFile(root, relative) {
    const resolved = path.resolve(root);
    requireCondition(fs.realpathSync(resolved) === resolved, 'Publish source root must not be a symlink.');
    const file = path.join(resolved, relative);
    for (const part of [path.dirname(path.dirname(file)), path.dirname(file), file]) {
        requireCondition(!fs.lstatSync(part).isSymbolicLink() && fs.realpathSync(part) === part, 'Publish source symlinks are forbidden.');
    }
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0);
    const descriptor = fs.openSync(file, flags);
    try {
        const before = fs.fstatSync(descriptor);
        requireCondition(before.isFile() && before.size <= MAX_BYTES, 'Publish source must be a bounded regular file.');
        const bytes = fs.readFileSync(descriptor), after = fs.fstatSync(descriptor);
        const current = completeSourcePathIdentity(file, fs.lstatSync(file), flags);
        requireCondition(after.size === bytes.length && bytes.length <= MAX_BYTES && before.ino === current.ino &&
            before.dev === current.dev && !current.isSymbolicLink(), 'Publish source identity changed while reading.');
        return bytes;
    } finally { fs.closeSync(descriptor); }
}

function sourceDigest(relative, bytes) {
    return relative === WORKFLOW ? workflowContractSha256(bytes.toString('utf8'))
        : crypto.createHash('sha256').update(bytes).digest('hex');
}

function assertSourceContract(context, remote = true) {
    for (const [relative, expected] of [[WORKFLOW, PUBLISH_SOURCE_SHA256], [SELECTOR, SELECTOR_SHA256]]) {
        requireCondition(sourceDigest(relative, readContractFile(context.root, relative)) === expected,
            'Publish source differs from the reviewed contract.');
        if (!remote) continue;
        const content = record(context.fetch(context.base + '/contents/' + relative + '?ref=' + context.request.commit));
        requireCondition(content.type === 'file' && content.path === relative && content.encoding === 'base64' &&
            typeof content.content === 'string' && content.content.length <= MAX_BYTES, 'Publish source content is missing or foreign.');
        const encoded = content.content.replace(/\n/gu, ''), bytes = Buffer.from(encoded, 'base64');
        requireCondition(bytes.toString('base64') === encoded && content.size === bytes.length &&
            sourceDigest(relative, bytes) === expected, 'Publish authenticated source differs from the reviewed contract.');
    }
}

function assertTag(context) {
    const ref = record(context.fetch(context.base + '/git/ref/tags/' + encodeURIComponent(context.request.tag)));
    requireCondition(ref.ref === 'refs/tags/' + context.request.tag, 'Publish tag reference is foreign.');
    let object = record(ref.object);
    const seen = new Set();
    for (let depth = 0; object.type === 'tag'; depth += 1) {
        requireCondition(depth < MAX_TAG_DEPTH && typeof object.sha === 'string' && /^[a-f0-9]{40}$/u.test(object.sha) &&
            !seen.has(object.sha), 'Publish annotated tag chain is cyclic or unbounded.');
        seen.add(object.sha);
        const tag = record(context.fetch(context.base + '/git/tags/' + object.sha));
        requireCondition(tag.sha === object.sha && (depth > 0 || tag.tag === context.request.tag), 'Publish annotated tag identity is foreign.');
        object = record(tag.object);
    }
    requireCondition(object.type === 'commit' && object.sha === context.request.commit, 'Publish tag resolves to another commit.');
}

function readPages(context, endpoint, key, limit) {
    const records = [], identities = new Set();
    let total = null;
    for (let page = 1; page <= MAX_PAGES; page += 1) {
        const payload = record(context.fetch(endpoint + '&page=' + page));
        requireCondition(Number.isSafeInteger(payload.total_count) && payload.total_count >= 0 && payload.total_count <= limit &&
            (total === null || payload.total_count === total) && Array.isArray(payload[key]), 'Publish history is incomplete or outside its bound.');
        total = payload.total_count;
        requireCondition(payload[key].length > 0 || total === 0, 'Publish paginated history is incomplete.');
        for (const value of payload[key]) {
            const entry = record(value), id = positiveInteger(entry.id);
            requireCondition(typeof entry.id === 'number', 'Publish provider identity must be a numeric integer ID.');
            requireCondition(!identities.has(id), 'Publish history has a duplicate or replayed identity.');
            identities.add(id); records.push(entry);
        }
        requireCondition(records.length <= total, 'Publish history exceeds its authenticated count.');
        if (records.length === total) return records;
    }
    throw new Error('Publish pagination did not complete within its bound.');
}

function timestamp(value, now) {
    requireCondition(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u.test(value),
        'Publish evidence timestamp is missing.');
    const time = Date.parse(value);
    requireCondition(Number.isFinite(time) && time <= now + CLOCK_SKEW_MS && now - time <= MAX_AGE_MS,
        'Publish evidence timestamp is stale or in the future.');
    return time;
}

function assertRunIdentity(context, run, expectedId, expectedAttempt) {
    const request = context.request;
    requireCondition(run.id === expectedId && run.run_attempt === expectedAttempt && run.workflow_id === context.workflowId &&
        run.head_sha === request.commit && record(run.repository).full_name === request.repository &&
        record(run.head_repository).full_name === request.repository, 'Publish run or attempt identity is foreign.');
    requireCondition(run.event === 'workflow_dispatch' && run.head_branch === request.tag &&
        [WORKFLOW, WORKFLOW + '@' + request.tag].includes(run.path), 'Publish run is not the authorized manual tag workflow.');
}

function assertRun(context, input, expectedId, expectedAttempt) {
    const run = record(input), request = context.request;
    assertRunIdentity(context, run, expectedId, expectedAttempt);
    const current = run.id === request.runId && run.run_attempt === request.runAttempt;
    requireCondition(current ? run.status === 'in_progress' && run.conclusion === null
        : run.status === 'completed' && TERMINAL.includes(run.conclusion), 'Publish history contains an active concurrent or uncertain run.');
    const started = timestamp(run.run_started_at, context.now), ended = timestamp(run.updated_at, context.now);
    requireCondition(started <= ended, 'Publish attempt chronology is inconsistent.');
    return { run, started, ended: current ? null : ended };
}

function runIdentity(run) {
    return JSON.stringify([run.id, run.run_attempt, run.workflow_id, run.head_sha, run.head_branch, run.path, run.event,
        run.repository.full_name, run.head_repository.full_name, run.status, run.conclusion, run.run_started_at]);
}

function readRunHistory(context) {
    const current = record(context.fetch(context.base + '/actions/runs/' + context.request.runId));
    assertRun(context, current, context.request.runId, context.request.runAttempt);
    const currentIdentity = runIdentity(current);
    const history = readPages(context, context.base + '/actions/workflows/publish.yml/runs?branch=' +
        encodeURIComponent(context.request.tag) + '&per_page=100', 'workflow_runs', MAX_ATTEMPTS);
    requireCondition(history.filter(run => run.id === current.id).length === 1, 'Publish history is missing the current run.');
    let attempts = 0;
    const timelines = history.map(run => {
        attempts += positiveInteger(run.run_attempt);
        requireCondition(attempts <= MAX_ATTEMPTS, 'Publish shared tag retry budget is exhausted.');
        const authoritative = record(context.fetch(context.base + '/actions/runs/' + positiveInteger(run.id)));
        const timeline = assertRun(context, authoritative, run.id, run.run_attempt);
        requireCondition(runIdentity(run) === runIdentity(authoritative), 'Publish history metadata is replayed or inconsistent.');
        return timeline;
    }).sort((left, right) => left.started - right.started);
    requireCondition(timelines.at(-1).run.id === current.id, 'Publish current run is superseded by later history.');
    requireCondition(runIdentity(timelines.at(-1).run) === currentIdentity, 'Publish current run changed during history reconstruction.');
    for (let index = 1; index < timelines.length; index += 1) {
        requireCondition(timelines[index - 1].ended <= timelines[index].started, 'Publish run chronology overlaps; same-tag serialization is required.');
    }
    return { currentIdentity, timelines, attempts };
}

function readAttempts(context, timeline) {
    const attempts = [];
    for (let ordinal = 1; ordinal <= timeline.run.run_attempt; ordinal += 1) {
        const metadata = context.fetch(context.base + '/actions/runs/' + timeline.run.id + '/attempts/' + ordinal);
        const attempt = assertRun(context, metadata, timeline.run.id, ordinal);
        const previous = attempts.at(-1);
        requireCondition(!previous || previous.ended <= attempt.started, 'Publish retained attempt chronology overlaps or is reversed.');
        attempts.push(attempt);
    }
    requireCondition(runIdentity(attempts.at(-1).run) === runIdentity(timeline.run), 'Publish latest attempt metadata is inconsistent.');
    return attempts;
}

function assertSerializedAttempts(attempts) {
    const ordered = [...attempts].sort((left, right) => left.started - right.started);
    for (let index = 1; index < ordered.length; index += 1) {
        requireCondition(ordered[index - 1].ended !== null && ordered[index - 1].ended <= ordered[index].started,
            'Publish attempt chronology overlaps; same-tag serialization is required.');
    }
}

function assertStepIdentity(step) {
    requireCondition(typeof step.name === 'string' && step.name.length > 0 && step.name.length <= 256 &&
        Number.isSafeInteger(step.number) && step.number > 0, 'Publish job step identity is missing.');
}

function assertUnstartedStep(step) {
    requireCondition(step.started_at === null && step.completed_at === null &&
        (step.status === 'queued' ? step.conclusion === null : step.conclusion === 'skipped'), 'Publish unstarted step metadata is uncertain.');
}

function assertCompletedStep(context, step, job, started) {
    requireCondition(step.status === 'completed' && TERMINAL.includes(step.conclusion) &&
        started <= timestamp(step.completed_at, context.now) && (job.completed_at === null ||
            timestamp(step.completed_at, context.now) <= timestamp(job.completed_at, context.now) + CLOCK_SKEW_MS),
    'Publish ' + job.name + ' step completion metadata is uncertain.');
}

function assertStep(context, step, job) {
    record(step);
    assertStepIdentity(step);
    requireCondition(job.status !== 'completed' || step.status === 'completed', 'Publish completed job contains an incomplete step.');
    if (step.status === 'queued' || step.status === 'completed' && step.conclusion === 'skipped' && step.started_at === null) {
        assertUnstartedStep(step);
        return;
    }
    const started = timestamp(step.started_at, context.now);
    requireCondition(started >= timestamp(job.started_at, context.now) - CLOCK_SKEW_MS, 'Publish ' + job.name + ' step timestamps precede its job.');
    if (step.status === 'in_progress') {
        requireCondition(job.status === 'in_progress' && step.conclusion === null && step.completed_at === null, 'Publish active step metadata is uncertain.');
        return;
    }
    assertCompletedStep(context, step, job, started);
}

function assertJobIdentity(context, job, attempts) {
    requireCondition([AUTH_JOB, VALIDATE_JOB, STAGE_JOB].includes(job.name) && job.run_id === attempts[0].run.id &&
        job.head_sha === context.request.commit && Number.isSafeInteger(job.run_attempt) && job.run_attempt > 0 &&
        job.run_attempt <= attempts.length, 'Publish job identity is foreign or missing.');
}

function assertJobTimeline(context, job, attempts) {
    if (job.status === 'queued') {
        assertPendingStage(context, job);
        return;
    }
    const attempt = attempts[job.run_attempt - 1];
    const upperBound = attempt.ended ?? context.now;
    const started = timestamp(job.started_at, context.now);
    requireCondition(started >= attempt.started - CLOCK_SKEW_MS && started <= upperBound + CLOCK_SKEW_MS &&
        ['completed', 'in_progress'].includes(job.status), 'Publish job history has invalid status or chronology.');
    requireCondition(job.status === 'completed' ? TERMINAL.includes(job.conclusion) &&
        started <= timestamp(job.completed_at, context.now) && timestamp(job.completed_at, context.now) <= upperBound + CLOCK_SKEW_MS
        : job.conclusion === null && job.completed_at === null, 'Publish ' + job.name + ' completion history is uncertain.');
}

function assertJobSteps(context, job) {
    requireCondition(Array.isArray(job.steps) && job.steps.length <= 100, 'Publish job steps are missing or unbounded.');
    const names = new Set(), numbers = new Set();
    for (const step of job.steps) {
        assertStep(context, step, job);
        requireCondition(!names.has(step.name) && !numbers.has(step.number), 'Publish job step identity is duplicate.');
        names.add(step.name); numbers.add(step.number);
    }
    requireCondition(job.conclusion !== 'success' || job.steps.every(step => ['success', 'skipped'].includes(step.conclusion)),
        'Publish successful job contains an unsuccessful step.');
}

function assertJob(context, job, attempts) {
    assertJobIdentity(context, job, attempts);
    assertJobTimeline(context, job, attempts);
    assertJobSteps(context, job);
}

function requiredStep(job, name, status) {
    const step = job.steps.find(entry => entry.name === name);
    requireCondition(step && step.status === status && (status === 'completed' ? step.conclusion === 'success'
        : step.conclusion === null), 'Publish authorization or required ' + name + ' step is missing or replaced.');
    return step;
}

function assertAuthorization(job) {
    requireCondition(job && job.status === 'completed' && job.conclusion === 'success' &&
        job.steps.every(step => step.status === 'completed' && ['success', 'skipped'].includes(step.conclusion)),
    'Publish authorization job did not succeed.');
    requiredStep(job, 'Authorize selected jobs', 'completed');
}

function isCurrentJob(context, job) {
    return job.run_id === context.request.runId && job.run_attempt === context.request.runAttempt;
}

function assertPendingStage(context, job) {
    requireCondition(job.name === STAGE_JOB && isCurrentJob(context, job) && context.request.phase === 'validate' &&
        job.status === 'queued' && job.conclusion === null && job.started_at === null && job.completed_at === null,
        'Publish pending stage identity or unstarted metadata is uncertain.');
    requireCondition(Array.isArray(job.steps) && job.steps.every(step => record(step).status === 'queued' &&
        step.conclusion === null && step.started_at === null && step.completed_at === null),
        'Publish pending stage steps have executed or are uncertain.');
}

function assertStage(context, job) {
    if (job.status === 'queued') {
        assertPendingStage(context, job);
        return;
    }
    const current = isCurrentJob(context, job) && context.request.phase === 'stage-publish';
    if (!current) {
        requireCondition(job.status === 'completed' && job.conclusion === 'skipped' && job.steps.every(step =>
            step.status === 'completed' && step.conclusion === 'skipped' && step.started_at === null && step.completed_at === null),
        'Publish prior stage history is executed, failed, cancelled or uncertain; restaging is forbidden.');
        return;
    }
    requireCondition(job.status === 'in_progress' && job.conclusion === null, 'Publish current staging job is not active.');
    const guard = requiredStep(job, 'Check publication history before staging', 'in_progress');
    const stage = requiredStep(job, STAGE_STEP, 'queued');
    requireCondition(stage.number > guard.number && stage.started_at === null && stage.completed_at === null &&
        job.steps.filter(step => step.status === 'in_progress').length === 1, 'Publish npm stage ordering is uncertain or execution has begun.');
}

function assertPastValidation(validation, stage) {
    requireCondition(validation.status === 'completed' && ['success', 'failure', 'cancelled', 'timed_out'].includes(validation.conclusion) &&
        stage && stage.status === 'completed' && stage.conclusion === 'skipped', 'Publish prior validation or stage history is incomplete.');
}

function assertCurrentValidation(context, validation, stage) {
    requireCondition(stage, 'Publish current validation stage history is missing.');
    requireCondition(validation.run_attempt === context.request.runAttempt && validation.status === 'in_progress',
        'Publish current validation attempt is missing or replayed.');
    requiredStep(validation, 'Check publication history before validation', 'in_progress');
}

function assertStagingValidation(context, validation, stage) {
    requireCondition(validation.status === 'completed' && validation.conclusion === 'success' && stage &&
        stage.run_attempt === context.request.runAttempt, 'Publish staging lacks successful validation or current stage history.');
    for (const name of VALIDATION_STEPS) requiredStep(validation, name, 'completed');
}

function assertAttemptCoverage(context, attempts, history) {
    const effective = new Map();
    for (const attempt of attempts) {
        const own = history.filter(job => job.run_attempt === attempt.run.run_attempt);
        requireCondition(own.length > 0, 'Publish attempt is missing complete job history.');
        for (const job of own) effective.set(job.name, job);
        assertAuthorization(effective.get(AUTH_JOB));
        const validation = effective.get(VALIDATE_JOB), stage = effective.get(STAGE_JOB);
        const current = attempt.run.id === context.request.runId && attempt.run.run_attempt === context.request.runAttempt;
        requireCondition(validation, 'Publish validation history is missing.');
        requireCondition(timestamp(effective.get(AUTH_JOB).completed_at, context.now) <= timestamp(validation.started_at, context.now) + CLOCK_SKEW_MS,
            'Publish authorization chronology follows validation.');
        if (!current) {
            assertPastValidation(validation, stage);
        } else if (context.request.phase === 'validate') {
            assertCurrentValidation(context, validation, stage);
        } else {
            assertStagingValidation(context, validation, stage);
        }
    }
}

function assertRunJobs(context, timeline) {
    const attempts = readAttempts(context, timeline);
    const history = readPages(context, context.base + '/actions/runs/' + timeline.run.id + '/jobs?filter=all&per_page=100',
        'jobs', MAX_ATTEMPTS * 3);
    const identities = new Set();
    for (const job of history) {
        assertJob(context, job, attempts);
        const identity = job.name + ':' + job.run_attempt;
        requireCondition(!identities.has(identity), 'Publish job/attempt identity is duplicate or replayed.');
        identities.add(identity);
        if (job.name === AUTH_JOB) assertAuthorization(job);
        if (job.name === STAGE_JOB) assertStage(context, job);
    }
    assertAttemptCoverage(context, attempts, history);
    return attempts;
}

function verifyPublishHistory(input, dependencies = {}) {
    const request = normalizeRequest(input), now = dependencies.now || new Date();
    requireCondition(now instanceof Date && Number.isFinite(now.getTime()), 'Publish verifier clock is invalid.');
    const context = { request, now: now.getTime(), root: dependencies.root || process.cwd(),
        fetch: dependencies.fetch || fetchAuthenticated, base: 'repos/' + request.repository };
    assertSourceContract(context);
    const workflow = record(context.fetch(context.base + '/actions/workflows/publish.yml'));
    requireCondition(workflow.path === WORKFLOW && workflow.state === 'active', 'Publish workflow identity is invalid.');
    context.workflowId = positiveInteger(workflow.id);
    assertTag(context);
    const history = readRunHistory(context);
    const attempts = history.timelines.flatMap(timeline => assertRunJobs(context, timeline));
    assertSerializedAttempts(attempts);
    const current = record(context.fetch(context.base + '/actions/runs/' + request.runId));
    assertRun(context, current, request.runId, request.runAttempt);
    requireCondition(runIdentity(current) === history.currentIdentity, 'Publish current run changed during verification.');
    assertTag(context);
    assertSourceContract(context, false);
    return { run_id: request.runId, run_attempt: request.runAttempt, repository: request.repository,
        commit: request.commit, tag: request.tag, phase: request.phase, total_attempts: history.attempts,
        prior_run_ids: history.timelines.filter(entry => entry.run.id !== request.runId).map(entry => entry.run.id).sort((a, b) => a - b) };
}

function main() {
    try {
        requireCondition(process.argv.length === 3 && process.env.GITHUB_EVENT_NAME === 'workflow_dispatch' &&
            process.env.GITHUB_REF_TYPE === 'tag', 'Publish guard requires one phase and a manual tag runner invocation.');
        const proof = verifyPublishHistory({ repository: process.env.GITHUB_REPOSITORY, commit: process.env.GITHUB_SHA,
            tag: process.env.GITHUB_REF_NAME, runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT,
            phase: process.argv[2] });
        process.stdout.write('PUBLISH_HISTORY_VERIFIED ' + JSON.stringify(proof) + '\n');
    } catch (error) {
        process.stderr.write('PUBLISH_HISTORY_REJECTED: ' + error.message + '\n');
        process.exitCode = 1;
    }
}

module.exports = { verifyPublishHistory };
if (require.main === module) main();
