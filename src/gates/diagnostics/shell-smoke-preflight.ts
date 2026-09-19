import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CLI_ENTRYPOINT_CANDIDATES } from '../../core/constants';
import {
    buildGateChainLaunchDecision,
    formatGateChainLaunchDecision
} from '../../core/dependent-validation-chains';
import {
    buildGitChangeClassificationEvidence,
    classifyGitChanges,
    type GitChangeClassificationEvidence
} from '../../core/git-change-classification';

import { redactPath } from '../../core/redaction';
import {
    assertValidTaskId,
    readTaskTimelineJsonlEntries,
    taskTimelineAwareFileExists
} from '../../gate-runtime/task-events';
import { withTaskTimelineFileReadSnapshot } from '../../gate-runtime/timeline/task-timeline-read-snapshot';
import {
    describePrePreflightCycleAnchor,
    getLatestPrePreflightCycleAnchor
} from '../preflight/pre-preflight-cycle-anchor';
import {
    fileSha256,
    isOrchestratorSourceCheckout,
    joinOrchestratorPath,
    normalizePath,
    resolvePathInsideRepo,
    toPosix
} from '../shared/helpers';

export interface ShellSmokeProbe {
    check: string;
    status: 'ok' | 'warning' | 'error';
    detail: string;
    elapsed_ms?: number;
}

export interface ShellSmokePreflightArtifact {
    schema_version: 1;
    timestamp_utc: string;
    event_source: 'shell-smoke-preflight';
    task_id: string;
    status: 'PASSED' | 'FAILED';
    outcome: 'PASS' | 'FAIL';

    provider: string | null;
    execution_context: 'source-checkout' | 'materialized-bundle';
    effective_cwd: string;
    workspace_root: string;

    git_change_classification?: GitChangeClassificationEvidence | null;
    probes: ShellSmokeProbe[];
    violations: string[];
}

export interface ShellSmokeEvidenceResult {
    task_id: string | null;
    evidence_path: string | null;
    evidence_hash: string | null;
    evidence_status: string;
    provider: string | null;
    violations: string[];
}

export interface BuildShellSmokePreflightOptions {
    taskId: string;
    repoRoot: string;
    provider?: string | null;
    effectiveCwd?: string | null;
    probeTimeoutMs?: number;
    precheckViolations?: string[];
}

const DEFAULT_PROBE_TIMEOUT_MS = 10_000;

interface TimelineEventEntry {
    event_type: string;
    sequence: number;
    details: Record<string, unknown> | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readTimelineEvents(timelinePath: string): TimelineEventEntry[] {
    const events: TimelineEventEntry[] = [];
    let sequence = 0;

    for (const timelineEntry of readTaskTimelineJsonlEntries(timelinePath)) {
        const parsed = timelineEntry.record;
        if (!parsed) {
            sequence += 1;
            continue;
        }
        try {
            const eventType = String(parsed.event_type || '').trim().toUpperCase();
            if (!eventType) {
                sequence += 1;
                continue;
            }
            events.push({
                event_type: eventType,
                sequence,
                details: isRecord(parsed.details) ? parsed.details : null
            });
        } catch {
            // Ignore malformed timeline lines here; upstream timeline collectors surface JSON errors separately.
        }
        sequence += 1;
    }

    return events;
}

function readTimelineEventsIfPresent(timelinePath: string): TimelineEventEntry[] | null {
    return withTaskTimelineFileReadSnapshot(timelinePath, () => (
        taskTimelineAwareFileExists(timelinePath) ? readTimelineEvents(timelinePath) : null
    ));
}

function findLatestTimelineEvent(
    events: readonly TimelineEventEntry[],
    eventType: string
): TimelineEventEntry | null {
    const normalizedEventType = String(eventType || '').trim().toUpperCase();
    for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        if (event.event_type === normalizedEventType) {
            return event;
        }
    }
    return null;
}

function runProbe(label: string, fn: () => string): ShellSmokeProbe {
    const start = Date.now();
    try {
        const detail = fn();
        return { check: label, status: 'ok', detail, elapsed_ms: Date.now() - start };
    } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        return { check: label, status: 'error', detail: msg, elapsed_ms: Date.now() - start };
    }
}

function spawnProbe(command: string, args: string[], cwd: string, timeoutMs: number): string {
    const result = childProcess.spawnSync(command, args, {
        cwd,
        timeout: timeoutMs,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        shell: false
    });
    if (result.error) {
        throw result.error;
    }
    if (result.status !== 0) {
        const stderr = (result.stderr || '').trim();
        throw new Error(`Exit code ${result.status}${stderr ? `: ${stderr}` : ''}`);
    }
    return (result.stdout || '').trim();
}

function probeCwd(cwd: string): ShellSmokeProbe {
    return runProbe('cwd', () => {
        if (!fs.existsSync(cwd)) {
            throw new Error(`cwd does not exist: ${cwd}`);
        }
        const stat = fs.statSync(cwd);
        if (!stat.isDirectory()) {
            throw new Error(`cwd is not a directory: ${cwd}`);
        }
        return `cwd=${toPosix(cwd)}`;
    });
}

function probeNodeVersion(cwd: string, timeoutMs: number): ShellSmokeProbe {
    return runProbe('node_version', () => {
        const version = spawnProbe(process.execPath, ['--version'], cwd, timeoutMs);
        return `node=${version}`;
    });
}

function probeGitState(cwd: string, timeoutMs: number): {
    probe: ShellSmokeProbe;
    evidence: GitChangeClassificationEvidence | null;
} {
    let evidence: GitChangeClassificationEvidence | null = null;
    const probe = runProbe('git_state', () => {
        const deadlineMs = Date.now() + timeoutMs;
        const branch = spawnProbe('git', ['rev-parse', '--abbrev-ref', 'HEAD'], cwd, timeoutMs);
        const remainingMs = deadlineMs - Date.now();
        if (remainingMs <= 0) {
            throw new Error(`Git-state probe exceeded its ${timeoutMs}ms timeout.`);
        }
        evidence = buildGitChangeClassificationEvidence(classifyGitChanges(cwd, {
            timeoutMs: remainingMs
        }));
        return (
            `branch=${branch}, changed_files=${evidence.effective_changed_files.length}, ` +
            `staged=${evidence.staged_files.length}, unstaged=${evidence.unstaged_files.length}, ` +
            `untracked=${evidence.untracked_files.length}, eol_only=${evidence.eol_only_files.length}; ` +
            `normalization=${evidence.normalization_rationale}`
        );
    });
    return { probe, evidence };
}

function probeFileRead(repoRoot: string, isSourceCheckout: boolean): ShellSmokeProbe {
    return runProbe('file_read', () => {
        const candidates = ['VERSION', 'MANIFEST.md', 'package.json'];
        const searchRoots = [repoRoot];
        if (!isSourceCheckout) {
            searchRoots.push(joinOrchestratorPath(repoRoot, ''));
        }
        for (const root of searchRoots) {
            for (const candidate of candidates) {
                const fullPath = path.join(root, candidate);
                if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
                    const content = fs.readFileSync(fullPath, 'utf8');
                    const lines = content.split('\n').length;
                    const relPath = path.relative(repoRoot, fullPath);
                    return `read=${toPosix(relPath)}, lines=${lines}`;
                }
            }
        }
        throw new Error('No readable probe file found (tried VERSION, MANIFEST.md, package.json)');
    });
}

function probeTempFileWriteDelete(repoRoot: string): ShellSmokeProbe {
    return runProbe('temp_file_write_delete', () => {
        const runtimeDir = joinOrchestratorPath(repoRoot, 'runtime');
        fs.mkdirSync(runtimeDir, { recursive: true });
        const tempFileName = `.shell-smoke-probe-${Date.now()}.tmp`;
        const tempFilePath = path.join(runtimeDir, tempFileName);
        const probeContent = `shell-smoke-probe ${new Date().toISOString()}`;

        fs.writeFileSync(tempFilePath, probeContent, 'utf8');

        if (!fs.existsSync(tempFilePath)) {
            throw new Error(`Temp file write failed: ${tempFileName} not found after write`);
        }
        const readBack = fs.readFileSync(tempFilePath, 'utf8');
        if (readBack !== probeContent) {
            fs.unlinkSync(tempFilePath);
            throw new Error('Temp file content mismatch after write');
        }

        fs.unlinkSync(tempFilePath);
        if (fs.existsSync(tempFilePath)) {
            throw new Error(`Temp file delete failed: ${tempFileName} still exists after unlink`);
        }
        return `write_delete=ok, dir=${toPosix(path.relative(repoRoot, runtimeDir))}`;
    });
}

function probeCliLaunchability(repoRoot: string, isSourceCheckout: boolean, timeoutMs: number): ShellSmokeProbe {
    return runProbe('cli_launchability', () => {
        const cliScriptCandidates = CLI_ENTRYPOINT_CANDIDATES.map((entrypoint) => (
            isSourceCheckout
                ? path.join(repoRoot, entrypoint)
                : joinOrchestratorPath(repoRoot, entrypoint)
        ));
        const cliScript = cliScriptCandidates.find(fs.existsSync) || cliScriptCandidates[0];

        if (!fs.existsSync(cliScript)) {
            throw new Error(`CLI script not found: ${toPosix(path.relative(repoRoot, cliScript))}`);
        }

        const output = spawnProbe(process.execPath, [cliScript, '--version'], repoRoot, timeoutMs);
        return `cli=ok, version=${output}`;
    });
}

export function resolveShellSmokeArtifactPath(repoRoot: string, taskId: string, artifactPath = ''): string {
    const explicit = String(artifactPath || '').trim();
    if (explicit) {
        const resolved = resolvePathInsideRepo(explicit, repoRoot, { allowMissing: true });
        if (!resolved) {
            throw new Error('ShellSmokeArtifactPath must not be empty.');
        }
        return resolved;
    }
    return joinOrchestratorPath(repoRoot, path.join('runtime', 'reviews', `${taskId}-shell-smoke.json`));
}

export function buildShellSmokePreflight(options: BuildShellSmokePreflightOptions): ShellSmokePreflightArtifact {
    const taskId = assertValidTaskId(options.taskId);
    const repoRoot = path.resolve(String(options.repoRoot || '.'));
    const isSourceCheckout = isOrchestratorSourceCheckout(repoRoot);
    const provider = String(options.provider || '').trim() || null;
    const effectiveCwd = options.effectiveCwd
        ? String(options.effectiveCwd).trim()
        : toPosix(repoRoot);
    const timeoutMs = options.probeTimeoutMs || DEFAULT_PROBE_TIMEOUT_MS;
    const precheckViolations = Array.isArray(options.precheckViolations)
        ? options.precheckViolations.map((entry) => String(entry || '').trim()).filter(Boolean)
        : [];

    const probes: ShellSmokeProbe[] = [];
    const violations: string[] = [...precheckViolations];
    let gitChangeClassification: GitChangeClassificationEvidence | null = null;

    if (precheckViolations.length === 0) {
        probes.push(probeCwd(repoRoot));
        probes.push(probeNodeVersion(repoRoot, timeoutMs));
        const gitState = probeGitState(repoRoot, timeoutMs);
        probes.push(gitState.probe);
        gitChangeClassification = gitState.evidence;
        probes.push(probeFileRead(repoRoot, isSourceCheckout));
        probes.push(probeTempFileWriteDelete(repoRoot));
        probes.push(probeCliLaunchability(repoRoot, isSourceCheckout, timeoutMs));

        for (const probe of probes) {
            if (probe.status === 'error') {
                violations.push(`Probe '${probe.check}' failed: ${probe.detail}`);
            }
        }
    }

    const hasErrors = violations.length > 0;
    return {
        schema_version: 1,
        timestamp_utc: new Date().toISOString(),
        event_source: 'shell-smoke-preflight',
        task_id: taskId,
        status: hasErrors ? 'FAILED' : 'PASSED',
        outcome: hasErrors ? 'FAIL' : 'PASS',
        provider,
        execution_context: isSourceCheckout ? 'source-checkout' : 'materialized-bundle',
        effective_cwd: redactPath(effectiveCwd, repoRoot),
        workspace_root: redactPath(toPosix(repoRoot)),
        git_change_classification: gitChangeClassification,
        probes,
        violations
    };
}

export interface GetShellSmokeEvidenceOptions {
    artifactPath?: string;
    timelinePath?: string;
}

export function getShellSmokeEvidence(repoRoot: string, taskId: string | null, artifactPathOrOptions: string | GetShellSmokeEvidenceOptions = ''): ShellSmokeEvidenceResult {
    const opts: GetShellSmokeEvidenceOptions = typeof artifactPathOrOptions === 'string'
        ? { artifactPath: artifactPathOrOptions }
        : artifactPathOrOptions;
    const result: ShellSmokeEvidenceResult = {
        task_id: taskId,
        evidence_path: null,
        evidence_hash: null,
        evidence_status: 'UNKNOWN',
        provider: null,
        violations: []
    };

    if (!taskId) {
        result.evidence_status = 'TASK_ID_MISSING';
        return result;
    }

    const resolvedTaskId = assertValidTaskId(taskId);
    const resolvedPath = resolveShellSmokeArtifactPath(repoRoot, resolvedTaskId, opts.artifactPath || '');
    result.evidence_path = normalizePath(resolvedPath);

    if (!fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isFile()) {
        result.evidence_status = 'EVIDENCE_FILE_MISSING';
        result.violations.push(
            `Shell smoke preflight evidence missing: file not found at '${result.evidence_path}'. ` +
            'Run shell-smoke-preflight before implementation gates.'
        );
        return result;
    }

    let artifact: Record<string, unknown>;
    try {
        artifact = JSON.parse(fs.readFileSync(resolvedPath, 'utf8')) as Record<string, unknown>;
    } catch {
        result.evidence_status = 'EVIDENCE_INVALID_JSON';
        result.violations.push(`Shell smoke preflight evidence is invalid JSON at '${result.evidence_path}'.`);
        return result;
    }

    result.evidence_hash = fileSha256(resolvedPath);
    result.provider = String(artifact.provider || '').trim() || null;

    const evidenceTaskId = String(artifact.task_id || '').trim();
    if (evidenceTaskId !== resolvedTaskId) {
        result.evidence_status = 'EVIDENCE_TASK_MISMATCH';
        result.violations.push(
            `Shell smoke preflight task mismatch. Expected '${resolvedTaskId}', got '${evidenceTaskId}'.`
        );
        return result;
    }

    const eventSource = String(artifact.event_source || '').trim();
    if (eventSource !== 'shell-smoke-preflight') {
        result.evidence_status = 'EVIDENCE_SOURCE_INVALID';
        result.violations.push(
            `Shell smoke preflight evidence source is invalid. Expected 'shell-smoke-preflight', got '${eventSource}'.`
        );
        return result;
    }

    const timelineViolations = verifyShellSmokeTimelineBinding(resolvedTaskId, result.evidence_hash, opts.timelinePath);
    if (timelineViolations.length > 0) {
        result.evidence_status = 'EVIDENCE_TIMELINE_UNBOUND';
        result.violations.push(...timelineViolations);
        return result;
    }

    const status = String(artifact.status || '').trim().toUpperCase();
    const outcome = String(artifact.outcome || '').trim().toUpperCase();
    if (status === 'PASSED' && outcome === 'PASS') {
        result.evidence_status = 'PASS';
        return result;
    }

    result.evidence_status = 'PASS_WITH_VIOLATIONS';
    const artifactViolations = Array.isArray(artifact.violations) ? artifact.violations : [];
    for (const v of artifactViolations) {
        result.violations.push(`Shell smoke probe violation: ${String(v)}`);
    }

    return result;
}

function verifyShellSmokeTimelineBinding(
    taskId: string,
    artifactHash: string | null,
    timelinePath?: string
): string[] {
    if (!timelinePath) return [];

    const resolvedTimeline = path.resolve(timelinePath);
    const events = readTimelineEventsIfPresent(resolvedTimeline);
    if (!events) {
        return [];
    }

    const latestCycleAnchor = getLatestPrePreflightCycleAnchor(events);
    const latestHandshake = findLatestTimelineEvent(events, 'HANDSHAKE_DIAGNOSTICS_RECORDED');
    const latestShellSmoke = findLatestTimelineEvent(events, 'SHELL_SMOKE_PREFLIGHT_RECORDED');

    if (!latestCycleAnchor) {
        return [
            `Shell smoke preflight evidence is not bound to an active task cycle for '${taskId}'. ` +
            `Task timeline '${normalizePath(resolvedTimeline)}' is missing TASK_MODE_ENTERED. ` +
            'Run enter-task-mode, then rerun handshake-diagnostics and shell-smoke-preflight sequentially.'
        ];
    }

    if (!latestHandshake) {
        return [
            `Shell smoke preflight evidence is not bound to a handshake for '${taskId}'. ` +
            `Task timeline '${normalizePath(resolvedTimeline)}' is missing HANDSHAKE_DIAGNOSTICS_RECORDED. ` +
            'Run handshake-diagnostics before shell-smoke-preflight.'
        ];
    }

    if (!latestShellSmoke) {
        return [
            `Shell smoke preflight evidence is not bound to task timeline for '${taskId}'. ` +
            `SHELL_SMOKE_PREFLIGHT_RECORDED event is missing from '${normalizePath(resolvedTimeline)}'. ` +
            'Run shell-smoke-preflight gate to emit proper lifecycle evidence.'
        ];
    }

    if (latestHandshake.sequence < latestCycleAnchor.sequence) {
        return [
            `Latest HANDSHAKE_DIAGNOSTICS_RECORDED evidence in '${normalizePath(resolvedTimeline)}' predates the ` +
            `${describePrePreflightCycleAnchor(latestCycleAnchor)} ` +
            `(handshake seq ${latestHandshake.sequence}). ` +
            'Re-run handshake-diagnostics for the current task cycle before shell-smoke-preflight. ' +
            'Do not parallelize enter-task-mode, handshake-diagnostics, and shell-smoke-preflight for the same task cycle.'
        ];
    }

    if (latestShellSmoke.sequence < latestCycleAnchor.sequence) {
        return [
            `Latest SHELL_SMOKE_PREFLIGHT_RECORDED evidence in '${normalizePath(resolvedTimeline)}' predates the ` +
            `${describePrePreflightCycleAnchor(latestCycleAnchor)} ` +
            `(shell-smoke seq ${latestShellSmoke.sequence}). ` +
            'Re-run handshake-diagnostics and shell-smoke-preflight for the current task cycle before classify-change or compile-gate.'
        ];
    }

    if (latestShellSmoke.sequence < latestHandshake.sequence) {
        const decision = buildGateChainLaunchDecision({
            edgeId: 'handshake-to-shell-smoke',
            status: 'block',
            reason: 'latest HANDSHAKE_DIAGNOSTICS_RECORDED is newer than latest SHELL_SMOKE_PREFLIGHT_RECORDED',
            context: { taskId },
            evidencePaths: [resolvedTimeline],
            remediationKind: 'stale_consumer'
        });
        return [
            `Unsafe same-task overlap detected in '${normalizePath(resolvedTimeline)}': latest HANDSHAKE_DIAGNOSTICS_RECORDED ` +
            `(seq ${latestHandshake.sequence}) is newer than latest SHELL_SMOKE_PREFLIGHT_RECORDED (seq ${latestShellSmoke.sequence}). ` +
            'Re-run shell-smoke-preflight after the latest handshake-diagnostics, then continue sequentially ' +
            '(shell-smoke-preflight -> classify-change -> load-rule-pack --stage POST_PREFLIGHT -> compile-gate). ' +
            'Do not parallelize handshake-diagnostics, shell-smoke-preflight, and classify-change for the same task cycle. ' +
            formatGateChainLaunchDecision(decision)
        ];
    }

    const recordedHash = latestShellSmoke.details && typeof latestShellSmoke.details.artifact_hash === 'string'
        ? latestShellSmoke.details.artifact_hash
        : null;
    if (artifactHash && recordedHash && artifactHash !== recordedHash) {
        return [
            `Shell smoke preflight artifact hash mismatch: file hash '${artifactHash}' ` +
            `does not match timeline-recorded hash '${recordedHash}'. ` +
            'The artifact may have been modified after the shell-smoke-preflight gate ran.'
        ];
    }

    return [];
}

export function getShellSmokeEvidenceViolations(result: ShellSmokeEvidenceResult): string[] {
    switch (result.evidence_status) {
        case 'PASS':
        case 'PASS_WITH_VIOLATIONS':
            return result.violations;
        case 'TASK_ID_MISSING':
            return ['Shell smoke preflight evidence cannot be verified: task id is missing.'];
        case 'EVIDENCE_FILE_MISSING':
            return result.violations;
        case 'EVIDENCE_INVALID_JSON':
            return result.violations;
        case 'EVIDENCE_TASK_MISMATCH':
            return result.violations;
        case 'EVIDENCE_SOURCE_INVALID':
            return result.violations;
        case 'EVIDENCE_TIMELINE_UNBOUND':
            return result.violations;
        default:
            return ['Shell smoke preflight evidence is missing or invalid. Run shell-smoke-preflight gate.'];
    }
}

export function formatShellSmokePreflightResult(artifact: ShellSmokePreflightArtifact): string[] {
    const lines: string[] = [
        artifact.outcome === 'PASS' ? 'SHELL_SMOKE_PREFLIGHT_PASSED' : 'SHELL_SMOKE_PREFLIGHT_FAILED',
        `TaskId: ${artifact.task_id}`,
        `Provider: ${artifact.provider || 'unknown'}`,
        `ExecutionContext: ${artifact.execution_context}`,
        `EffectiveCwd: ${artifact.effective_cwd}`,
        `WorkspaceRoot: ${artifact.workspace_root}`
    ];

    const gitChanges = artifact.git_change_classification;
    if (gitChanges) {
        const formatFiles = (files: string[]): string => files.length > 0 ? files.join(', ') : 'none';
        lines.push(
            `GitChangedFiles: ${formatFiles(gitChanges.effective_changed_files)}`,
            `GitChangeLayers: staged=${formatFiles(gitChanges.staged_files)}; ` +
                `unstaged=${formatFiles(gitChanges.unstaged_files)}; ` +
                `untracked=${formatFiles(gitChanges.untracked_files)}`,
            `GitEolAudit: policy=${gitChanges.policy_id}; eol_only=${formatFiles(gitChanges.eol_only_files)}; ` +
                `ignored_eol_only=${formatFiles(gitChanges.ignored_eol_only_files)}`,
            `GitNormalizationRationale: ${gitChanges.normalization_rationale}`
        );
    }

    if (artifact.probes.length > 0) {
        lines.push('Probes:');
        for (const p of artifact.probes) {
            const icon = p.status === 'ok' ? '+' : p.status === 'warning' ? '~' : '-';
            const timing = p.elapsed_ms != null ? ` (${p.elapsed_ms}ms)` : '';
            lines.push(`  [${icon}] ${p.check}: ${p.detail}${timing}`);
        }
    }

    if (artifact.violations.length > 0) {
        lines.push('Violations:');
        for (const v of artifact.violations) {
            lines.push(`  - ${v}`);
        }
    }

    return lines;
}
