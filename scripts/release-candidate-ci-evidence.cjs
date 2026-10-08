'use strict';

const childProcess = require('node:child_process');
const { verifyCiEvidence } = require('./manual-ci-evidence.cjs');

const MAX_CI_EVIDENCE_BYTES = 16 * 1024 * 1024;

function fetchCiEvidence(endpoint, paginate = false) {
    const args = ['api', '--hostname', 'github.com', endpoint];
    if (paginate) args.push('--paginate', '--slurp');
    const result = childProcess.spawnSync('gh', args, {
        encoding: 'utf8', windowsHide: true, maxBuffer: MAX_CI_EVIDENCE_BYTES
    });
    if (result.error || result.status !== 0) {
        throw new Error('Authenticated GitHub CI evidence is unavailable.');
    }
    return JSON.parse(result.stdout);
}

function verifyCiRun(runId, commit, repository, dependencies = {}) {
    const canonicalId = typeof runId === 'number' ? String(runId) : runId;
    if (typeof canonicalId !== 'string' || !/^[1-9][0-9]*$/u.test(canonicalId) ||
        !Number.isSafeInteger(Number(canonicalId))) {
        throw new Error('CI run ID must be a positive safe integer.');
    }
    return verifyCiEvidence(dependencies.root || process.cwd(),
        { ciRunId: Number(canonicalId), commit, repository },
        dependencies.now || new Date(), dependencies.fetch || fetchCiEvidence);
}

module.exports = { verifyCiRun };
