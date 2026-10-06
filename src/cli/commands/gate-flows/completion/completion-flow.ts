import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import {
    EXIT_GENERAL_FAILURE
} from '../../../exit-codes';
import {
    DEFAULT_GIT_TIMEOUT_MS,
    spawnSyncWithTimeout,
    spawnStreamed
} from '../../../../core/subprocess';
import {
    parseOperatorConfirmationYes,
    validateFreshOperatorConfirmation
} from '../../../../core/operator-confirmation';
import {
    appendTaskEvent,
    assertValidTaskId
} from '../../../../gate-runtime/task-events';
import { auditCommandCompactness } from '../../../../gates/task-events-summary/task-events-summary';
import {
    buildOrchestratorDefectCaptureSummary,
    ORCHESTRATOR_DEFECT_ACKNOWLEDGED_EVENT
} from '../../../../gates/task-audit/task-audit-summary-orchestrator-defects';
import type { CommandCompactnessAudit } from '../../../../gates/task-events-summary/task-events-summary';
import * as gateHelpers from '../../../../gates/shared/helpers';
import {
    cleanupTerminalCompileLogs,
    cleanupTerminalReviewTempOutputs,
    resolvePathForWrite,
    type TerminalLogCleanupResult
} from '../../../gate-cli/gates-artifacts';
import {
    toCommandPolicyAuditSummary
} from '../../../gate-cli/gates-formatter';
import {
    parseJsonOption
} from '../../../gate-cli/gates-parser';
import { requireResolvedPath } from '../../shared-command-utils';
import { bindContainedDestination, ensureContainedDirectory } from '../../../../core/contained-filesystem';
import { resolveLocalCommitAvailability } from '../../../../core/auth/local-commit-availability';
import { buildTaskAuditSummary, synchronizeFinalCloseoutArtifacts } from '../../../../gates/task-audit/task-audit-summary';
import {
    resolveOrchestratorRoot,
    isPlainObject
} from '../compile/gate-flow-helpers';

type CommandPolicyAudit = CommandCompactnessAudit;

export interface LogTaskEventCommandOptions {
    repoRoot?: string;
    eventsRoot?: string;
    taskId?: unknown;
    eventType?: unknown;
    outcome?: unknown;
    actor?: unknown;
    message?: unknown;
    detailsJson?: unknown;
}

export interface HumanCommitOptions {
    cwd?: string;
}

function parseHumanCommitInvocation(
    gitArgs: unknown,
    options: HumanCommitOptions
): { commitArgs: string[]; cwd: string; taskId: string } {
    const invocationCwd = options.cwd || process.cwd();
    let cwd = invocationCwd;
    let operatorConfirmed = false;
    let operatorConfirmedAtUtc: string | null = null;
    let taskId = '';
    const commitArgs: string[] = [];
    const rawArgs = gateHelpers.toStringArray(gitArgs).filter(function (item: string) {
        return String(item || '').trim() !== '';
    });

    for (let index = 0; index < rawArgs.length; index += 1) {
        const argument = rawArgs[index];
        if (argument === '--task-id') {
            if (taskId || !rawArgs[index + 1]) throw new Error('--task-id requires exactly one task identity.');
            taskId = assertValidTaskId(rawArgs[++index]);
            continue;
        }
        if (argument === '--') {
            commitArgs.push(...rawArgs.slice(index));
            break;
        }
        if (argument === '--repo-root') {
            const repoRoot = rawArgs[index + 1];
            if (!repoRoot) throw new Error('--repo-root requires a value.');
            cwd = path.resolve(invocationCwd, repoRoot);
            index += 1;
            continue;
        }
        if (argument.startsWith('--repo-root=')) {
            const repoRoot = argument.slice('--repo-root='.length);
            if (!repoRoot) throw new Error('--repo-root requires a value.');
            cwd = path.resolve(invocationCwd, repoRoot);
            continue;
        }
        if (argument === '--operator-confirmed') {
            const confirmation = rawArgs[index + 1];
            if (!confirmation) throw new Error('--operator-confirmed requires the exact value "yes".');
            operatorConfirmed = parseOperatorConfirmationYes(confirmation);
            index += 1;
            continue;
        }
        if (argument.startsWith('--operator-confirmed=')) {
            operatorConfirmed = parseOperatorConfirmationYes(argument.slice('--operator-confirmed='.length));
            continue;
        }
        if (argument === '--operator-confirmed-at-utc') {
            const confirmedAt = rawArgs[index + 1];
            if (!confirmedAt) throw new Error('--operator-confirmed-at-utc requires an ISO-8601 timestamp.');
            operatorConfirmedAtUtc = confirmedAt;
            index += 1;
            continue;
        }
        if (argument.startsWith('--operator-confirmed-at-utc=')) {
            operatorConfirmedAtUtc = argument.slice('--operator-confirmed-at-utc='.length);
            continue;
        }
        commitArgs.push(argument);
    }

    if (operatorConfirmed || operatorConfirmedAtUtc) validateFreshOperatorConfirmation({
        actionLabel: 'human-commit',
        confirmed: operatorConfirmed,
        confirmedAtUtc: operatorConfirmedAtUtc,
        instruction: 'Ask the user "Do you want me to commit now? (yes/no)" and rerun only after a yes response with --operator-confirmed yes.'
    });

    if (commitArgs.length === 0) {
        throw new Error('Provide git commit arguments, for example: -m "feat: message"');
    }

    const permission = resolveLocalCommitAvailability(cwd);
    if (!permission.enabled) throw new Error(`Local commit permission is disabled: ${permission.disabledReason}. ${permission.remediationCommand}`);
    if (!taskId) throw new Error('Native local commits require --task-id for completed, audited task scope.');
    const messageOnly = commitArgs.length === 2 && ['-m', '--message'].includes(commitArgs[0])
        || commitArgs.length === 1 && /^--message=.+/u.test(commitArgs[0]);
    if (!messageOnly) throw new Error('Native local commits accept only --message; amend, pathspec, hooks and index overrides are forbidden.');
    return { commitArgs, cwd, taskId };
}

interface CommandAuditPayload {
    command_text: string;
    mode: string;
    justification: string;
}

interface LogTaskEventCommandResult {
    status: string;
    task_id: string;
    event_type: string;
    outcome: string;
    actor: string;
    task_event_log_path: string;
    all_tasks_log_path: string;
    integrity?: NonNullable<ReturnType<typeof appendTaskEvent>>['integrity'];
    warnings?: string[];
    command_policy_audit?: CommandPolicyAudit;
    terminal_log_cleanup?: TerminalLogCleanupResult;
    terminal_review_temp_cleanup?: TerminalLogCleanupResult;
}

function toDetailsMap(detailsObject: unknown): Record<string, unknown> {
    if (detailsObject == null) {
        return {};
    }
    if (isPlainObject(detailsObject)) {
        return { ...detailsObject };
    }
    return {
        input_details: detailsObject
    };
}

function getCommandAuditPayload(detailsObject: unknown): CommandAuditPayload | null {
    if (!isPlainObject(detailsObject)) {
        return null;
    }

    let commandText = '';
    for (const candidateKey of ['command', 'command_text', 'shell_command']) {
        const value = detailsObject[candidateKey];
        if (typeof value === 'string' && value.trim()) {
            commandText = value.trim();
            break;
        }
    }
    if (!commandText) {
        return null;
    }

    return {
        command_text: commandText,
        mode: String(detailsObject.command_mode || detailsObject.mode || 'scan'),
        justification: String(detailsObject.command_justification || detailsObject.justification || '')
    };
}

export function runLogTaskEventCommand(options: LogTaskEventCommandOptions): { outputText: string; exitCode: number } {
    const repoRoot = path.resolve(String(options.repoRoot || '.'));
    const orchestratorRoot = resolveOrchestratorRoot(repoRoot);
    const eventsRoot = options.eventsRoot
        ? requireResolvedPath(resolvePathForWrite(options.eventsRoot, repoRoot), 'EventsRoot')
        : gateHelpers.joinOrchestratorPath(repoRoot, path.join('runtime', 'task-events'));
    const taskId = assertValidTaskId(String(options.taskId || '').trim());
    const eventType = String(options.eventType || '').trim();
    const outcome = String(options.outcome || 'INFO').trim().toUpperCase();
    const actor = String(options.actor || 'orchestrator').trim() || 'orchestrator';
    const message = String(options.message || '');
    const details = parseJsonOption(options.detailsJson || '', 'DetailsJson');

    if (!eventType) {
        throw new Error('EventType must not be empty.');
    }
    if (!['INFO', 'PASS', 'FAIL', 'BLOCKED'].includes(outcome)) {
        throw new Error(`Outcome must be one of INFO, PASS, FAIL, BLOCKED. Got '${outcome}'.`);
    }
    const reservedEventTypes = new Set([
        'TASK_MODE_ENTERED',
        'RULE_PACK_LOADED',
        'HANDSHAKE_DIAGNOSTICS_RECORDED',
        'SHELL_SMOKE_PREFLIGHT_RECORDED',
        'WORKFLOW_CONFIG_MUTATION_AUDITED',
        'WORKFLOW_CONFIG_MUTATION_PREPARED',
        'REVIEW_PHASE_STARTED',
        'REVIEW_RECORDED',
        'REVIEWER_DELEGATION_ROUTED',
        'REVIEWER_LAUNCH_PREPARED',
        'REVIEWER_INVOCATION_ATTESTED'
    ]);
    const reservedEventPattern = /^(COMPILE_GATE_|REVIEW_GATE_|REVIEWER_|PREFLIGHT_|COMPLETION_GATE_|FULL_SUITE_VALIDATION_|DOC_IMPACT_)/;
    const normalizedEventType = eventType.toUpperCase();
    if (reservedEventTypes.has(normalizedEventType) || reservedEventPattern.test(normalizedEventType)) {
        throw new Error(`EventType '${eventType}' is reserved and cannot be emitted via log-task-event.`);
    }
    if (normalizedEventType === ORCHESTRATOR_DEFECT_ACKNOWLEDGED_EVENT) {
        const capture = buildOrchestratorDefectCaptureSummary({
            repoRoot,
            taskId,
            events: [{ task_id: taskId, event_type: normalizedEventType, details }]
        });
        if (capture.status !== 'CAPTURED') {
            throw new Error(`${ORCHESTRATOR_DEFECT_ACKNOWLEDGED_EVENT} admission rejected: `
                + (capture.violations.join('; ') || capture.visible_summary_line));
        }
    }

    fs.mkdirSync(eventsRoot, { recursive: true });

    let eventDetails: unknown = details;
    let terminalLogCleanup: TerminalLogCleanupResult = {
        triggered: false,
        attempted_paths: 0,
        discovered_paths: [],
        deleted_paths: [],
        stale_deleted_paths: [],
        missing_paths: [],
        retained_paths: [],
        errors: []
    };
    let terminalReviewTempCleanup: TerminalLogCleanupResult = {
        triggered: false,
        attempted_paths: 0,
        discovered_paths: [],
        deleted_paths: [],
        stale_deleted_paths: [],
        missing_paths: [],
        retained_paths: [],
        errors: []
    };
    const isTerminalEvent = eventType === 'TASK_DONE' || eventType === 'TASK_BLOCKED';
    if (isTerminalEvent) {
        terminalLogCleanup = cleanupTerminalCompileLogs(repoRoot, taskId);
        terminalReviewTempCleanup = cleanupTerminalReviewTempOutputs(repoRoot, taskId);
        const detailsMap = toDetailsMap(eventDetails);
        detailsMap.terminal_log_cleanup = terminalLogCleanup;
        detailsMap.terminal_review_temp_cleanup = terminalReviewTempCleanup;
        eventDetails = detailsMap;
    }

    let commandCompactnessAudit: CommandPolicyAudit | null = null;
    const auditPayload = getCommandAuditPayload(eventDetails);
    if (auditPayload) {
        commandCompactnessAudit = auditCommandCompactness(auditPayload.command_text, {
            mode: auditPayload.mode,
            justification: auditPayload.justification
        });
        const detailsMap = toDetailsMap(eventDetails);
        detailsMap.command_policy_audit = commandCompactnessAudit;
        eventDetails = detailsMap;
    }

    const appendResult = appendTaskEvent(
        orchestratorRoot,
        taskId,
        eventType,
        outcome,
        message,
        eventDetails,
        {
            actor,
            passThru: true,
            eventsRoot
        }
    );
    const result: LogTaskEventCommandResult = {
        status: 'TASK_EVENT_LOGGED',
        task_id: taskId,
        event_type: eventType,
        outcome,
        actor,
        task_event_log_path: gateHelpers.normalizePath(path.join(eventsRoot, `${taskId}.jsonl`)),
        all_tasks_log_path: gateHelpers.normalizePath(path.join(eventsRoot, 'all-tasks.jsonl'))
    };

    if (appendResult && isPlainObject(appendResult.integrity)) {
        result.integrity = appendResult.integrity;
    }
    if (appendResult && Array.isArray(appendResult.warnings) && appendResult.warnings.length > 0) {
        result.warnings = [...appendResult.warnings];
    }
    if (commandCompactnessAudit) {
        result.command_policy_audit = commandCompactnessAudit;
        const auditSummary = toCommandPolicyAuditSummary(commandCompactnessAudit);
        if (auditSummary.warning_count > 0) {
            result.warnings = [...(result.warnings || []), ...auditSummary.warnings];
        }
    }
    if (isTerminalEvent) {
        result.terminal_log_cleanup = terminalLogCleanup;
        result.terminal_review_temp_cleanup = terminalReviewTempCleanup;
    }

    const cleanupFailed = isTerminalEvent
        && (terminalLogCleanup.errors.length > 0 || terminalReviewTempCleanup.errors.length > 0);
    if (cleanupFailed) {
        result.status = 'TASK_EVENT_LOGGED_CLEANUP_FAILED';
    }

    return {
        outputText: `${JSON.stringify(result, null, 2)}\n`,
        exitCode: cleanupFailed ? EXIT_GENERAL_FAILURE : 0
    };
}

function prepareNativeCommit(cwd: string) {
    if (Object.entries(process.env).some(([key, value]) => value
        && /^GIT_(?:DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|NAMESPACE|CONFIG(?:_.*)?|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|CEILING_DIRECTORIES)$/iu.test(key))) {
        throw new Error('Native local commits reject inherited Git workspace, index and configuration overrides.');
    }
    const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/iu.test(key)));
    const git = (args: string[], input?: Buffer, useCommitIndex = false) => {
        const result = spawnSyncWithTimeout('git', args, { cwd, input, encoding: 'utf8', timeoutMs: DEFAULT_GIT_TIMEOUT_MS,
            env: useCommitIndex ? { ...environment, GIT_INDEX_FILE: commitIndex } : environment });
        if (result.status !== 0) throw new Error(`Native commit Git inspection failed: ${result.stderr}`);
        return result.stdout;
    };
    const readHead = () => {
        const result = spawnSyncWithTimeout('git', ['rev-parse', '--verify', '--quiet', 'HEAD'], { cwd, encoding: 'utf8', timeoutMs: DEFAULT_GIT_TIMEOUT_MS, env: environment });
        if (result.status === 0) return result.stdout.trim();
        if (result.status === 1) return null;
        throw new Error(`Native commit HEAD inspection failed: ${result.stderr}`);
    };
    const head = readHead();
    for (const operation of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer']) {
        if (fs.existsSync(path.resolve(cwd, git(['rev-parse', '--git-path', operation]).trim()))) {
            throw new Error('Native local commits require an ordinary task commit outside an active merge, rebase or sequencer.');
        }
    }
    const indexPath = path.resolve(cwd, git(['rev-parse', '--git-path', 'index']).trim());
    const indexDirectory = path.join(resolveOrchestratorRoot(cwd), 'runtime', 'tmp');
    ensureContainedDirectory(cwd, indexDirectory);
    const commitIndex = path.join(indexDirectory, `local-commit-${process.pid}-${Date.now()}.index`);
    bindContainedDestination(cwd, commitIndex);
    fs.copyFileSync(indexPath, commitIndex, fs.constants.COPYFILE_EXCL);
    return { environment, git, readHead, head, indexPath, commitIndex };
}

function readNativeGitFileEntries(output: string, index: boolean): Map<string, { mode: string; objectId: string }> {
    const pattern = index ? /^(\d{6}) ([a-f0-9]{40,64}) 0$/u : /^(\d{6}) \w+ ([a-f0-9]{40,64})$/u;
    const entries = new Map<string, { mode: string; objectId: string }>();
    for (let offset = 0; offset < output.length;) {
        const end = output.indexOf('\0', offset);
        if (end < 0) throw new Error('Native commit rejects incomplete Git file entries.');
        const record = output.slice(offset, end);
        offset = end + 1;
        const separator = record.indexOf('\t');
        const match = pattern.exec(record.slice(0, separator));
        if (!match || separator < 0) throw new Error('Native commit rejects unresolved or invalid Git file entries.');
        entries.set(record.slice(separator + 1), { mode: match[1], objectId: match[2] });
    }
    return entries;
}

function assertAcceptedWorkingBytes(cwd: string, files: readonly string[], expectedHash: string | null | undefined, snapshots?: Map<string, Buffer | null>): void {
    const frames = [...new Set(files)].sort().map((file) => {
        const destination = path.resolve(cwd, file);
        bindContainedDestination(cwd, destination);
        if (!fs.existsSync(destination)) {
            snapshots?.set(file, null);
            return `${file}:missing`;
        }
        if (!fs.lstatSync(destination).isFile()) throw new Error('Native working-tree commits require regular files; use native staged validation for other file types.');
        const bytes = fs.readFileSync(destination);
        snapshots?.set(file, bytes);
        // Native worktree scope framing binds the captured bytes, rather than a later filesystem read.
        return `${file}:worktree:file:${bytes.length}:${createHash('sha256').update(bytes).digest('hex')}`;
    });
    if (createHash('sha256').update(frames.join('\n')).digest('hex') !== expectedHash) {
        throw new Error('Native commit captured content differs from authenticated accepted task evidence.');
    }
}

function assertAcceptedNativeIndexContent(
    cwd: string, prepared: ReturnType<typeof prepareNativeCommit>, files: string[], audit: ReturnType<typeof buildTaskAuditSummary>
): void {
    const implementation = audit.final_closeout.implementation_summary;
    // Native task audit reconstructs original staged/untracked provenance and binds blob modes/OIDs.
    if (implementation.audited_scope_provenance?.use_staged === true) return;
    const snapshots = new Map<string, Buffer | null>();
    assertAcceptedWorkingBytes(cwd, implementation.changed_files ?? [], implementation.scope_content_sha256, snapshots);
    const index = readNativeGitFileEntries(prepared.git(['--literal-pathspecs', 'ls-files', '--stage', '-z', '--', ...files]), true);
    const base = prepared.head ? readNativeGitFileEntries(prepared.git(['--literal-pathspecs', 'ls-tree', '-r', '-z', prepared.head, '--', ...files]), false) : new Map();
    for (const file of files) {
        const bytes = snapshots.get(file);
        const entry = index.get(file);
        if (bytes === null && !entry) continue;
        if (!entry || !bytes || !['100644', '100755'].includes(entry.mode)
            || entry.mode !== (base.get(file)?.mode ?? '100644')) {
            throw new Error('Native commit staged mode differs from accepted working-tree scope; use native staged validation for mode changes.');
        }
        const acceptedObjectId = prepared.git(['hash-object', `--path=${file}`, '--stdin'], bytes).trim();
        if (entry.objectId !== acceptedObjectId) throw new Error('Native commit staged content differs from authenticated accepted task evidence.');
    }
}

function assertNativeCommitReadiness(
    invocation: ReturnType<typeof parseHumanCommitInvocation>, prepared: ReturnType<typeof prepareNativeCommit>
) {
    const audit = buildTaskAuditSummary({ taskId: invocation.taskId, repoRoot: invocation.cwd });
    if (audit.status !== 'PASS' || !['PASS', 'PASS_WITH_LEGACY_PREFIX'].includes(audit.integrity_status)) {
        throw new Error(`Native local commit requires completion and task audit PASS: ${audit.status}.`);
    }
    const acceptedFiles = new Set(audit.final_closeout.implementation_summary.changed_files ?? []);
    const stagedFiles = prepared.git(['diff', '--cached', '--no-renames', '--name-only', '-z']).split('\0').filter(Boolean);
    if (stagedFiles.length === 0 || stagedFiles.some((file) => !acceptedFiles.has(file))) {
        throw new Error('Native local commit rejects empty or unrelated staged scope.');
    }
    assertAcceptedNativeIndexContent(invocation.cwd, prepared, stagedFiles, audit);
    const indexBytes = fs.readFileSync(prepared.indexPath);
    if (!indexBytes.equals(fs.readFileSync(prepared.commitIndex))
        || prepared.readHead() !== prepared.head
        || !resolveLocalCommitAvailability(invocation.cwd).enabled) throw new Error('Native commit readiness changed before Git launch.');
    return { audit, indexBytes, tree: prepared.git(['write-tree'], undefined, true).trim() };
}

function assertNativeCommitPublication(
    invocation: ReturnType<typeof parseHumanCommitInvocation>, prepared: ReturnType<typeof prepareNativeCommit>,
    accepted: ReturnType<typeof assertNativeCommitReadiness>
): void {
    bindContainedDestination(invocation.cwd, prepared.commitIndex);
    if (prepared.git(['write-tree'], undefined, true).trim() !== accepted.tree
        || !fs.readFileSync(prepared.indexPath).equals(accepted.indexBytes)
        || prepared.readHead() !== prepared.head
        || !resolveLocalCommitAvailability(invocation.cwd).enabled) {
        throw new Error('Native commit readiness changed after Git hooks; accepted scope must be validated again.');
    }
    const implementation = accepted.audit.final_closeout.implementation_summary;
    if (implementation.audited_scope_provenance?.use_staged !== true) {
        assertAcceptedWorkingBytes(invocation.cwd, implementation.changed_files ?? [], implementation.scope_content_sha256);
    }
}

async function runNativeCommitHook(
    invocation: ReturnType<typeof parseHumanCommitInvocation>, prepared: ReturnType<typeof prepareNativeCommit>,
    hook: string, args: string[] = []
): Promise<number> {
    const result = await spawnStreamed('git', ['hook', 'run', '--ignore-missing', hook, ...(args.length ? ['--', ...args] : [])], {
        cwd: invocation.cwd, inheritStdio: true, timeoutMs: DEFAULT_GIT_TIMEOUT_MS,
        env: { ...prepared.environment, GARDA_ALLOW_COMMIT: '1', GIT_INDEX_FILE: prepared.commitIndex, GIT_EDITOR: ':' }, envMode: 'replace'
    });
    return result.exitCode || (result.timedOut || result.cancelled || result.sinkError ? EXIT_GENERAL_FAILURE : 0);
}

function readNativeCommitSetting(prepared: ReturnType<typeof prepareNativeCommit>, cwd: string, key: string, boolean = false): string | null {
    const result = spawnSyncWithTimeout('git', ['config', ...(boolean ? ['--type=bool'] : []), '--get', key], {
        cwd, encoding: 'utf8', timeoutMs: DEFAULT_GIT_TIMEOUT_MS, env: prepared.environment
    });
    if (result.status === 1) return null;
    if (result.status !== 0) throw new Error(`Native commit configuration inspection failed: ${result.stderr}`);
    return result.stdout.trim();
}

function createAcceptedNativeCommit(
    invocation: ReturnType<typeof parseHumanCommitInvocation>, prepared: ReturnType<typeof prepareNativeCommit>, tree: string
): string {
    const messagePath = `${prepared.commitIndex}.message`;
    bindContainedDestination(invocation.cwd, messagePath);
    let message = fs.readFileSync(messagePath);
    const cleanup = readNativeCommitSetting(prepared, invocation.cwd, 'commit.cleanup') ?? 'default';
    if (!['default', 'whitespace', 'verbatim', 'strip', 'scissors'].includes(cleanup)) throw new Error(`Unsupported Git commit.cleanup: ${cleanup}.`);
    if (cleanup !== 'verbatim') message = Buffer.from(prepared.git(['stripspace', ...(cleanup === 'strip' ? ['--strip-comments'] : [])], message));
    if (!message.toString('utf8').trim()) throw new Error('Native commits require a nonempty commit message after hooks and cleanup.');
    const signing = readNativeCommitSetting(prepared, invocation.cwd, 'commit.gpgSign', true) === 'true' ? ['-S'] : [];
    // Publishing a pinned object prevents hook/background index writes from changing the accepted tree.
    return prepared.git(['commit-tree', tree, ...(prepared.head ? ['-p', prepared.head] : []), ...signing, '-F', '-'], message).trim();
}

function finalizeNativeCommit(
    invocation: ReturnType<typeof parseHumanCommitInvocation>, prepared: ReturnType<typeof prepareNativeCommit>,
    acceptedTree: string | undefined, publishedCommit: string | undefined
): void {
    const postCommitAudit = buildTaskAuditSummary({ taskId: invocation.taskId, repoRoot: invocation.cwd });
    synchronizeFinalCloseoutArtifacts(postCommitAudit);
    if (postCommitAudit.status !== 'PASS') throw new Error(`Post-commit task audit failed: ${postCommitAudit.status}. Preserve the commit for diagnosis.`);
    if (!acceptedTree || !publishedCommit || prepared.readHead() !== publishedCommit
        || prepared.git(['rev-parse', 'HEAD^{tree}']).trim() !== acceptedTree) {
        throw new Error('Local commit identity or tree changed; post-commit acceptance is blocked. Preserve the commit for diagnosis.');
    }
    const parentMatches = prepared.head === null
        ? prepared.git(['rev-list', '--parents', '-n', '1', 'HEAD']).trim().split(/\s+/u).length === 1
        : prepared.git(['rev-parse', 'HEAD^']).trim() === prepared.head;
    if (!parentMatches) throw new Error('Local commit parent changed; post-commit acceptance is blocked.');
}

export async function runHumanCommitCommand(gitArgs: unknown, options: HumanCommitOptions = {}): Promise<number> {
    const invocation = parseHumanCommitInvocation(gitArgs, options);
    const prepared = prepareNativeCommit(invocation.cwd);
    let accepted: ReturnType<typeof assertNativeCommitReadiness> | undefined;
    let publicationAttempted = false;
    let publishedCommit: string | undefined;
    try {
        accepted = assertNativeCommitReadiness(invocation, prepared);
        const messagePath = `${prepared.commitIndex}.message`;
        const message = invocation.commitArgs.length === 1 ? invocation.commitArgs[0].slice('--message='.length) : invocation.commitArgs[1];
        bindContainedDestination(invocation.cwd, messagePath);
        fs.writeFileSync(messagePath, `${message}\n`, { flag: 'wx', mode: 0o600 });
        for (const [hook, args] of [['pre-commit', []], ['prepare-commit-msg', [messagePath, 'message']], ['commit-msg', [messagePath]]] as const) {
            const exitCode = await runNativeCommitHook(invocation, prepared, hook, [...args]);
            if (exitCode !== 0) return exitCode;
        }
        assertNativeCommitPublication(invocation, prepared, accepted);
        const commit = createAcceptedNativeCommit(invocation, prepared, accepted.tree);
        assertNativeCommitPublication(invocation, prepared, accepted);
        publicationAttempted = true;
        prepared.git(['update-ref', '-m', `commit: ${message.split('\n')[0]}`, 'HEAD', commit, prepared.head ?? '0'.repeat(commit.length)]);
        publishedCommit = commit;
        return await runNativeCommitHook(invocation, prepared, 'post-commit');
    } finally {
        try {
            if (publicationAttempted || prepared.readHead() !== prepared.head) finalizeNativeCommit(invocation, prepared, accepted?.tree, publishedCommit);
        } finally {
            for (const suffix of ['', '.lock', '.message']) {
                bindContainedDestination(invocation.cwd, `${prepared.commitIndex}${suffix}`);
                fs.rmSync(`${prepared.commitIndex}${suffix}`, { force: true });
            }
        }
    }
}
