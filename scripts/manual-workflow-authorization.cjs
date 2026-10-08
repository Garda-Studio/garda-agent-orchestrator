#!/usr/bin/env node
'use strict';

const fs = require('node:fs');

const AUTHORIZATION_PHRASE = 'I authorize this selected run';
const OPERATING_SYSTEMS = ['ubuntu-latest', 'windows-latest', 'macos-latest'];
const RUNTIMES = ['22.13.0', '24'];
const LINUX = ['ubuntu-latest'];
const PROFILES = {
    ci: {
        runtimes: RUNTIMES,
        jobs: {
            typecheck: LINUX, 'test-unit': LINUX, 'test-gates': LINUX,
            'test-cli': LINUX, 'test-lifecycle': LINUX, 'test-bin': LINUX,
            release: ['ubuntu-latest', 'windows-latest'], smoke: OPERATING_SYSTEMS
        }
    },
    security: { runtimes: ['24'], jobs: { 'npm-audit': LINUX, osv: LINUX } },
    'secret-scanning': { runtimes: ['24'], jobs: { gitleaks: LINUX } },
    sbom: { runtimes: ['24'], jobs: { sbom: LINUX } },
    'smoke-schedule': { runtimes: RUNTIMES, jobs: { smoke: OPERATING_SYSTEMS } },
    publish: { runtimes: ['24'], jobs: { validate: LINUX, 'stage-publish': LINUX } }
};

function selectManualWorkflow(env) {
    const workflow = env.MANUAL_WORKFLOW;
    if (!Object.hasOwn(PROFILES, workflow)) throw new Error('Unknown workflow selection profile.');
    if (env.GITHUB_EVENT_NAME !== 'workflow_dispatch') throw new Error('Manual workflow dispatch is required.');
    if (env.MANUAL_AUTHORIZATION !== AUTHORIZATION_PHRASE) throw new Error('Explicit per-run authorization is required.');
    const repository = env.GITHUB_REPOSITORY;
    if (typeof repository !== 'string' || !/^[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/u.test(repository) ||
        env.MANUAL_REPOSITORY !== repository) throw new Error('Authorization must name the current repository exactly.');
    const commit = env.GITHUB_SHA;
    if (typeof commit !== 'string' || !/^[a-f0-9]{40}$/u.test(commit) || env.MANUAL_COMMIT !== commit) {
        throw new Error('The requested full SHA must equal the workflow run SHA.');
    }
    const profile = PROFILES[workflow];
    const job = env.MANUAL_JOB;
    if (typeof job !== 'string' || (job !== 'all' && !Object.hasOwn(profile.jobs, job))) {
        throw new Error('Unknown job selection.');
    }
    if (workflow === 'publish' && job === 'all') throw new Error('Publication requires an explicit operation selection.');
    const os = env.MANUAL_OS;
    if (os !== 'all' && !OPERATING_SYSTEMS.includes(os)) throw new Error('Unknown OS selection.');
    const runtime = env.MANUAL_RUNTIME;
    if (runtime !== 'all' && !profile.runtimes.includes(runtime)) throw new Error('Unsupported runtime selection.');
    const selected = job === 'all' ? Object.keys(profile.jobs)
        : workflow === 'publish' && job === 'stage-publish' ? ['validate', 'stage-publish'] : [job];
    if (job !== 'all' && os !== 'all' && !profile.jobs[job].includes(os)) {
        throw new Error('The selected job does not support the selected OS.');
    }
    const nodes = runtime === 'all' ? profile.runtimes : [runtime];
    const jobs = Object.fromEntries(Object.entries(profile.jobs).map(([id, supportedOs]) => {
        const include = selected.includes(id) ? supportedOs
            .filter(platform => os === 'all' || platform === os)
            .flatMap(platform => nodes.map(node => ({ os: platform, 'node-version': node }))) : [];
        return [id, { enabled: include.length > 0, matrix: { include } }];
    }));
    if (!Object.values(jobs).some(value => value.enabled)) throw new Error('Selection contains no supported job.');
    return {
        schema_version: 1, workflow, repository, commit, event: 'workflow_dispatch',
        requested: { job, os, runtime }, jobs,
        complete_matrix_requested: job === 'all' && os === 'all' && runtime === 'all'
    };
}

function main() {
    try {
        const selection = selectManualWorkflow(process.env);
        if (!process.env.GITHUB_OUTPUT) throw new Error('The runner output path is required.');
        fs.appendFileSync(process.env.GITHUB_OUTPUT, 'selection=' + JSON.stringify(selection) + '\n', 'utf8');
        process.stdout.write('MANUAL_SELECTION_PREPARED\n');
    } catch (error) {
        process.stderr.write('MANUAL_SELECTION_REJECTED: ' + error.message + '\n');
        process.exitCode = 1;
    }
}

module.exports = { AUTHORIZATION_PHRASE, selectManualWorkflow };
if (require.main === module) main();
