import * as childProcess from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { getRepoRoot } from '../build';
import { parseCanonicalActiveTaskQueue, type CanonicalActiveTaskQueueRow } from '../../../src/core/task-md-table';
import { readTaskQueueStatusToken } from '../../../src/core/task-queue/task-queue-status';
import { extractExplicitLinkedChildTaskIds, readDecomposedTaskProvenance } from '../../../src/gates/next-step/next-step-task-queue';
import { validateCleanWorktreePreflight } from './clean-worktree';
import { validateEmbeddedBundleParity } from './embedded-bundle-parity';
import { pushCheck } from './shared';
import type { ReleaseReadinessCheck } from './types';

const CI_WORKFLOW_SHA256 = '525c435c871bafa5b79ac47248bf180821ed750e2c26f53d2ddb05eab51a8f70';
const CI_SCRIPTS_SHA256 = '9da4ed2b6174b6bcd9aafbf2bb36aa76d06aa5c147ddfdf9204a3e26c3b35949';
const MAX_EVIDENCE_BYTES = 16 * 1024 * 1024;
const CLOCK_SKEW_MS = 5 * 60 * 1000;
const REQUIRED_RELEASE_TASKS = [
    { ids: ['T-057'], area: 'release/candidate-dev-toolchain-audit-proof' },
    { ids: ['T-083', 'T-1027'], area: 'release/release-provenance-checksum-policy' }
] as const;

export interface CandidateReadinessRequest {
    candidateDirectory: string;
    commit: string;
    tag: string;
    tarballSha256: string;
    tarballName: string;
    repository: string;
    ciRunId: number;
}

export type GithubEvidenceFetcher = (endpoint: string, paginate?: boolean) => unknown;
export interface CandidateReadinessDependencies {
    now?: Date;
    fetch?: GithubEvidenceFetcher;
}
export interface CandidateReadinessResult {
    decision: 'GO' | 'NO_GO';
    checks: ReleaseReadinessCheck[];
    violations: string[];
    taskQueueSha256: string | null;
}

interface SecurityAdapter {
    MAX_EVIDENCE_AGE_MS: number;
    workflowContractSha256(content: string): string;
    assertSecurityWorkflow(content: string): void;
    readJobsPayload(payload: unknown): Record<string, unknown>[];
    attestOrVerify(mode: string, args: string[], repoRoot: string, now: Date,
        fetch: (repository: string, runId: number) => { run: unknown; jobs: unknown }): unknown;
}

interface CandidateAdapter {
    assertSafeName(name: string): string;
    verifyManifest(directory: string, commit: string, tag: string, sha256: string, name: string): string;
}

function candidateAdapter(): CandidateAdapter {
    return require(path.join(getRepoRoot(), 'scripts', 'release-candidate.cjs')) as CandidateAdapter;
}

function readAuthoritativeRepository(): string {
    const metadata = record(JSON.parse(readRegularFile(path.join(getRepoRoot(), 'package.json')).toString('utf8')));
    const repository = record(metadata.repository);
    const match = typeof repository.url === 'string'
        ? /^(?:git\+)?https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/u.exec(repository.url) : null;
    if (repository.type !== 'git' || !match) throw new Error('Authoritative verifier repository metadata is missing or invalid.');
    return match[1];
}

function securityAdapter(): SecurityAdapter {
    return require(path.join(getRepoRoot(), 'scripts', 'release-security-evidence.cjs')) as SecurityAdapter;
}

export function hasReviewedSecurityWorkflow(repoRoot: string): boolean {
    try {
        securityAdapter().assertSecurityWorkflow(readRegularFile(path.join(repoRoot, '.github', 'workflows', 'security.yml')).toString('utf8'));
        return true;
    } catch {
        return false;
    }
}

function sha256(bytes: string | Buffer): string {
    return crypto.createHash('sha256').update(bytes).digest('hex');
}

function readRegularFile(filePath: string): Buffer {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_EVIDENCE_BYTES) {
        throw new Error('Evidence input must be a bounded regular file: ' + path.basename(filePath));
    }
    return fs.readFileSync(filePath);
}

function fetchGithubEvidence(endpoint: string, paginate = false): unknown {
    const args = ['api', '--hostname', 'github.com', endpoint];
    if (paginate) args.push('--paginate', '--slurp');
    const result = childProcess.spawnSync('gh', args, {
        encoding: 'utf8', windowsHide: true, maxBuffer: MAX_EVIDENCE_BYTES
    });
    if (result.error || result.status !== 0) throw new Error('Authenticated GitHub CI evidence is unavailable.');
    return JSON.parse(result.stdout);
}

function record(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid evidence object.');
    return value as Record<string, unknown>;
}

function recentTimestamp(value: unknown, now: Date, maxAgeMs: number): number {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u.test(value)) {
        throw new Error('CI evidence timestamp is missing or invalid.');
    }
    const timestamp = Date.parse(value);
    if (!Number.isFinite(timestamp) || timestamp > now.getTime() + CLOCK_SKEW_MS || now.getTime() - timestamp > maxAgeMs) {
        throw new Error('CI evidence is stale or in the future.');
    }
    return timestamp;
}

function requiredCiJobs(): Map<string, string[]> {
    const jobs = new Map<string, string[]>();
    for (const node of ['22.13.0', '24']) {
        for (const [name, step] of [
            ['Static Checks', 'Run typecheck'], ['Unit Tests', 'Run unit tests'],
            ['Gate Tests', 'Run gate tests (parallel shards)'], ['CLI Tests', 'Run CLI tests (parallel shards)'],
            ['Lifecycle Tests', 'Run lifecycle tests'], ['Binary Tests', 'Run binary tests']
        ]) jobs.set(name + ' / Node ' + node, name === 'Static Checks'
            ? [step, 'Run lint'] : ['Build node-foundation', step]);
        for (const os of ['ubuntu-latest', 'windows-latest']) {
            jobs.set('Release Validation / ' + os + ' / Node ' + node, ['Validate release']);
        }
        for (const os of ['ubuntu-latest', 'windows-latest', 'macos-latest']) {
            jobs.set('Smoke / ' + os + ' / Node ' + node, [
                'Build', 'Build staged node-foundation test graph', 'Pack and install smoke test',
                'Lifecycle smoke (cross-platform E2E install → update → uninstall)'
            ]);
        }
    }
    return jobs;
}

function validateCiEvidence(repoRoot: string, request: CandidateReadinessRequest, now: Date, fetch: GithubEvidenceFetcher): void {
    const adapter = securityAdapter();
    const workflow = readRegularFile(path.join(repoRoot, '.github', 'workflows', 'ci.yml')).toString('utf8');
    const scripts = record(JSON.parse(readRegularFile(path.join(repoRoot, 'package.json')).toString('utf8'))).scripts;
    if (adapter.workflowContractSha256(workflow) !== CI_WORKFLOW_SHA256 ||
        sha256(JSON.stringify(Object.entries(record(scripts)).sort(([a], [b]) => a.localeCompare(b, 'en')))) !== CI_SCRIPTS_SHA256) {
        throw new Error('CI workflow or npm scripts differ from the reviewed complete-suite contract.');
    }
    const endpoint = 'repos/' + request.repository + '/actions/runs/' + request.ciRunId;
    const run = record(fetch(endpoint));
    if (run.id !== request.ciRunId || run.head_sha !== request.commit ||
        record(run.repository).full_name !== request.repository ||
        !['.github/workflows/ci.yml', '.github/workflows/ci.yml@' + run.head_branch].includes(String(run.path)) ||
        !['dev', 'main', 'master'].includes(String(run.head_branch)) ||
        !['push', 'workflow_dispatch'].includes(String(run.event)) ||
        run.status !== 'completed' || run.conclusion !== 'success' ||
        !Number.isSafeInteger(run.run_attempt) || Number(run.run_attempt) < 1) {
        throw new Error('CI run is absent, failed, skipped, foreign, or for another candidate commit.');
    }
    const completed = recentTimestamp(run.updated_at, now, adapter.MAX_EVIDENCE_AGE_MS);
    const started = recentTimestamp(run.run_started_at, now, adapter.MAX_EVIDENCE_AGE_MS);
    if (started > completed) throw new Error('CI run timeline is inconsistent.');
    const jobs = adapter.readJobsPayload(fetch(endpoint + '/jobs?per_page=100', true));
    const required = requiredCiJobs();
    const ids = new Set<unknown>();
    if (jobs.length !== required.size) throw new Error('CI suite job matrix is incomplete or unexpected.');
    for (const job of jobs) {
        const steps = required.get(String(job.name));
        if (!steps || ids.has(job.id) || !Number.isSafeInteger(job.id) || Number(job.id) <= 0 ||
            job.run_id !== run.id || job.head_sha !== request.commit ||
            job.run_attempt !== run.run_attempt || job.status !== 'completed' || job.conclusion !== 'success') {
            throw new Error('CI suite job identity, attempt, or non-skipped success is invalid.');
        }
        ids.add(job.id);
        required.delete(String(job.name));
        const jobStarted = recentTimestamp(job.started_at, now, adapter.MAX_EVIDENCE_AGE_MS);
        const jobCompleted = recentTimestamp(job.completed_at, now, adapter.MAX_EVIDENCE_AGE_MS);
        if (jobStarted < started - CLOCK_SKEW_MS || jobStarted > jobCompleted || jobCompleted > completed + CLOCK_SKEW_MS) {
            throw new Error('CI job timeline is inconsistent.');
        }
        if (!Array.isArray(job.steps)) throw new Error('CI job steps are missing.');
        const actualSteps = job.steps.map(record);
        if (actualSteps.some(step => step.status !== 'completed' || !['success', 'skipped'].includes(String(step.conclusion)))) {
            throw new Error('CI job contains a failed or incomplete step.');
        }
        for (const name of ['Install dependencies', ...steps]) {
            if (actualSteps.filter(step => step.name === name && step.status === 'completed' && step.conclusion === 'success').length !== 1) {
                throw new Error('CI job lacks a successful required step: ' + name);
            }
        }
    }
    if (required.size !== 0) throw new Error('CI suite has uninspected mandatory jobs.');
}

function isPostReleaseFeature(row: CanonicalActiveTaskQueueRow, boundary: CanonicalActiveTaskQueueRow): boolean {
    return row.lineIndex > boundary.lineIndex && !row.area.startsWith('release/') &&
        /(?:^|[.;]\s*)Post-release only(?:[.;]|$)/iu.test(row.notes);
}

function validateTaskBlockers(queue: Buffer): void {
    const parsed = parseCanonicalActiveTaskQueue(queue.toString('utf8'));
    if (!parsed.found || parsed.rows.length === 0) throw new Error('Canonical local task queue is unavailable.');
    const rows = new Map(parsed.rows.map(row => [row.taskId, row]));
    if (rows.size !== parsed.rows.length) throw new Error('Local task queue contains duplicate identities.');
    const boundaries = parsed.rows.filter(row => row.area === 'release/pre-release-go-no-go');
    if (boundaries.length !== 1) throw new Error('Exactly one release boundary must identify the release lane.');
    const boundary = boundaries[0];
    const roots = parsed.rows.filter(row => row.lineIndex < boundary.lineIndex);
    for (const requirement of REQUIRED_RELEASE_TASKS) {
        const matches = parsed.rows.filter(row => row.area === requirement.area);
        if (matches.length !== 1 || !requirement.ids.some(id => id === matches[0].taskId)) {
            throw new Error('Mandatory release prerequisite is missing or ambiguous: ' + requirement.ids.join('/'));
        }
        roots.push(matches[0]);
    }
    if (roots.length === 0) throw new Error('Release lane has no prerequisite tasks.');
    const visited = new Set<string>();
    const pending = new Set<string>();
    const visit = (id: string): void => {
        if (pending.has(id)) throw new Error('Release task decomposition cycle: ' + id);
        if (visited.has(id)) return;
        const row = rows.get(id);
        if (!row) throw new Error('Missing release child task: ' + id);
        if (isPostReleaseFeature(row, boundary)) return;
        pending.add(id);
        const status = readTaskQueueStatusToken(row.status);
        const children = extractExplicitLinkedChildTaskIds(row.notes, rows.keys(), row.taskId);
        const provenance = readDecomposedTaskProvenance(row.notes);
        if (status !== 'DONE' && status !== 'DECOMPOSED') {
            throw new Error('Unfinished release task: ' + id + ' (' + String(status) + ')');
        }
        if (status === 'DECOMPOSED' || provenance.source !== 'unrecorded') {
            if (children.length < 2) throw new Error('Release decomposition lacks explicit children: ' + id);
        } else if (status !== 'DONE') {
            throw new Error('Unfinished release task: ' + id + ' (' + String(status) + ')');
        }
        for (const child of children) visit(child);
        pending.delete(id);
        visited.add(id);
    };
    for (const row of roots) visit(row.taskId);
}

function validateRequest(request: CandidateReadinessRequest): void {
    candidateAdapter().assertSafeName(request.tarballName);
    if (!path.isAbsolute(request.candidateDirectory) || !/^[a-f0-9]{40}$/u.test(request.commit) ||
        !/^[a-f0-9]{64}$/u.test(request.tarballSha256) || !/^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(request.tag) ||
        !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(request.repository) ||
        !Number.isSafeInteger(request.ciRunId) || request.ciRunId <= 0) {
        throw new Error('Candidate readiness identity is missing or invalid.');
    }
}

export function validateCandidateReadiness(
    repoRoot: string, request: CandidateReadinessRequest, dependencies: CandidateReadinessDependencies = {}
): CandidateReadinessResult {
    const checks: ReleaseReadinessCheck[] = [];
    const violations: string[] = [];
    const now = dependencies.now || new Date();
    const fetch = dependencies.fetch || fetchGithubEvidence;
    const queuePath = path.join(repoRoot, 'TASK.md');
    let verifyCandidate: (() => void) | null = null;
    let securityEvidence: Buffer | null = null;
    let queue: Buffer | null = null;
    const inspect = (area: string, label: string, validation: () => void): void => {
        try {
            validation();
            pushCheck(checks, violations, area, label, true, []);
        } catch (error) {
            pushCheck(checks, violations, area, label, false, [error instanceof Error ? error.message : 'Evidence validation failed.']);
        }
    };
    inspect('candidate-identity', 'explicit immutable candidate identity is valid', () => {
        validateRequest(request);
        if (!Number.isFinite(now.getTime())) throw new Error('Invalid evidence verification time.');
        const clean = validateCleanWorktreePreflight(repoRoot);
        if (request.repository !== readAuthoritativeRepository()) {
            throw new Error('Requested repository differs from the authoritative verifier repository.');
        }
        const version = record(JSON.parse(readRegularFile(path.join(repoRoot, 'package.json')).toString('utf8'))).version;
        if (!clean.passed || clean.headSha !== request.commit || request.tag !== 'v' + version) {
            throw new Error('Candidate checkout must be clean at the exact commit and version.');
        }
    });
    inspect('release-task-blockers', 'current release lane and recursive children are complete', () => {
        queue = readRegularFile(queuePath);
        validateTaskBlockers(queue);
    });
    inspect('mandatory-parity', 'mandatory embedded parity inspected actual items', () => {
        const parity = validateEmbeddedBundleParity(repoRoot);
        if (parity.status !== 'PASSED' || parity.items.length === 0) throw new Error(parity.violations.join('; ') || 'Mandatory parity did not inspect items.');
    });
    if (checks[0]?.passed) {
        inspect('candidate-integrity', 'exact tarball digest and contents manifest are reverified', () => {
            const adapter = candidateAdapter();
            verifyCandidate = () => { adapter.verifyManifest(request.candidateDirectory, request.commit, request.tag, request.tarballSha256, request.tarballName); };
            verifyCandidate();
        });
        inspect('candidate-suite', 'authenticated current complete CI suite and platform matrix succeeded', () => {
            validateCiEvidence(repoRoot, request, now, fetch);
        });
        inspect('candidate-security', 'candidate-bound full dependency and OSV evidence is live-verified', () => {
            securityEvidence = readRegularFile(path.join(request.candidateDirectory, 'security-evidence.json'));
            securityAdapter().attestOrVerify('verify', [
                request.candidateDirectory, request.commit, request.tag, request.tarballSha256, request.tarballName, request.repository
            ], repoRoot, now, (repository, runId) => {
                const endpoint = 'repos/' + repository + '/actions/runs/' + runId;
                return { run: fetch(endpoint), jobs: fetch(endpoint + '/jobs?per_page=100', true) };
            });
        });
    }
    inspect('candidate-recheck', 'checkout and operator queue stayed unchanged during verification', () => {
        const clean = validateCleanWorktreePreflight(repoRoot);
        if (!clean.passed || clean.headSha !== request.commit || !queue || !readRegularFile(queuePath).equals(queue) ||
            !securityEvidence || !readRegularFile(path.join(request.candidateDirectory, 'security-evidence.json')).equals(securityEvidence)) {
            throw new Error('Candidate checkout, evidence or local task blockers changed during verification.');
        }
        if (!verifyCandidate) throw new Error('Candidate integrity was not inspected.');
        verifyCandidate();
    });
    return { decision: violations.length === 0 ? 'GO' : 'NO_GO', checks, violations,
        taskQueueSha256: queue ? sha256(queue) : null };
}

export function parseCandidateReadinessArgs(args: string[]): CandidateReadinessRequest | undefined {
    if (args.length === 0) return undefined;
    if (args.length !== 8 || args[0] !== '--candidate') {
        throw new Error('Usage: release-readiness [--candidate <absolute-dir> <commit> <tag> <sha256> <tarball-name> <owner/repo> <ci-run-id>]');
    }
    const request = { candidateDirectory: args[1], commit: args[2], tag: args[3], tarballSha256: args[4],
        tarballName: args[5], repository: args[6], ciRunId: Number(args[7]) };
    if (!/^[1-9]\d*$/u.test(args[7])) throw new Error('CI run ID must be a positive decimal integer.');
    validateRequest(request);
    return request;
}
