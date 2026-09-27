import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
    LIFECYCLE_COMMANDS
} from '../../core/constants';
import { collectUpdateAnnouncements } from '../../lifecycle/update-announcements';
import { compareVersionStrings } from '../../lifecycle/generic-utils';
import { type CheckUpdateRunnerOptions } from '../../lifecycle/check-update';
import { captureLifecycleLockHandoff } from '../../lifecycle/lock/lifecycle-lock-handoff';
import { isPathInsideRoot } from '../../core/paths';
import { cyan, getBundlePath, green, yellow } from './cli-helpers';

export type ParsedOptionValue = string | boolean | string[] | undefined;
export type ParsedOptionsRecord = Record<string, ParsedOptionValue>;

export interface UpdateLifecycleResult extends Record<string, unknown> {
    previousVersion?: unknown;
    updatedVersion?: unknown;
    workflowConfigMergeStatus?: unknown;
    optionalQualityChecksNotice?: unknown;
    projectMemoryMaintenanceSummaryLine?: unknown;
    projectMemoryRefreshHandoffPrompt?: unknown;
    rollbackSnapshotPath?: unknown;
    rollbackStatus?: unknown;
    updateReportPath?: unknown;
    requestedPackageSpec?: unknown;
    exactPackageSpec?: unknown;
    resolvedPackageVersion?: unknown;
    resolvedPackageIntegrity?: unknown;
    releaseProvenanceStatus?: unknown;
    releaseProvenanceSummary?: unknown;
    releaseProvenanceRecommendation?: unknown;
    gitCommitSha?: unknown;
    updateMessages?: unknown;
    releaseNotes?: unknown;
    updateAnnouncementWarnings?: unknown;
}

let runtimeRestartRequired = false;

export function markRuntimeRestartRequired(): void {
    runtimeRestartRequired = true;
}

export function assertRuntimeRestartNotRequired(): void {
    if (runtimeRestartRequired) {
        throw new Error('The bundle changed in this process. Start a new Garda process before running another command.');
    }
}

export class ValidationFailureError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ValidationFailureError';
        Object.setPrototypeOf(this, ValidationFailureError.prototype);
    }
}

export class GateFailureError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'GateFailureError';
        Object.setPrototypeOf(this, GateFailureError.prototype);
    }
}

export function countStoragePolicyActions(storagePolicyResult: { removed: string[]; compressed: string[] } | undefined): number {
    if (!storagePolicyResult) {
        return 0;
    }
    return storagePolicyResult.removed.length + storagePolicyResult.compressed.length;
}

export function getPackageRoot(): string {
    return path.resolve(__dirname, '..', '..', '..', '..');
}

export function requireResolvedPath(resolvedPath: string | null, label: string): string {
    if (!resolvedPath) {
        throw new Error(`${label} must not be empty.`);
    }
    return resolvedPath;
}

export function removeArtifactIfExists(filePath: string | null | undefined): void {
    if (!filePath) {
        return;
    }
    try {
        if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
            fs.rmSync(filePath, { force: true });
        }
    } catch {
        // Best-effort cleanup only. The original failure should surface.
    }
}

export function toKeyValueRecord(value: unknown): Record<string, unknown> {
    return value as Record<string, unknown>;
}

export function buildKeyValueOutputLines(obj: Record<string, unknown> | null | undefined, keys: string[]): string[] {
    const lines: string[] = [];
    if (!obj) {
        return lines;
    }
    for (const key of keys) {
        if (obj[key] === undefined) {
            continue;
        }
        const label = key.charAt(0).toUpperCase() + key.slice(1);
        const value = typeof obj[key] === 'boolean'
            ? (obj[key] ? 'True' : 'False')
            : String(obj[key]);
        lines.push(`${label}: ${value}`);
    }
    return lines;
}

export function formatKeyValueOutput(obj: Record<string, unknown> | null | undefined, keys: string[]): void {
    for (const line of buildKeyValueOutputLines(obj, keys)) {
        console.log(line);
    }
}

function toPrintableLines(value: unknown): string[] {
    if (!Array.isArray(value)) {
        return [];
    }
    return value
        .map((entry) => String(entry ?? '').trim())
        .filter((entry) => entry.length > 0);
}

function stripMarkdownBulletPrefix(line: string): string {
    return line.replace(/^[-*]\s+/, '').trim();
}

type AnnouncementSectionTone = 'default' | 'warning';
const ANNOUNCEMENT_COMMAND_HIGHLIGHTS = Object.freeze([
    'garda ui --actions'
]);

function colorAnnouncementSectionTitle(title: string, tone: AnnouncementSectionTone): string {
    if (tone === 'warning') {
        return yellow(`${title}:`);
    }
    return cyan(`${title}:`);
}

function colorAnnouncementSectionLine(line: string, tone: AnnouncementSectionTone): string {
    if (tone === 'warning') {
        return yellow(line);
    }

    for (const commandText of ANNOUNCEMENT_COMMAND_HIGHLIGHTS) {
        const commandIndex = line.indexOf(commandText);
        if (commandIndex >= 0) {
            const prefix = line.slice(0, commandIndex);
            const suffix = line.slice(commandIndex + commandText.length);
            return `${green(prefix)}${yellow(commandText)}${green(suffix)}`;
        }
    }

    return green(line);
}

function printAnnouncementSection(title: string, lines: string[], tone: AnnouncementSectionTone = 'default'): void {
    if (lines.length === 0) {
        return;
    }
    console.log('');
    console.log(colorAnnouncementSectionTitle(title, tone));
    for (const line of lines) {
        console.log(colorAnnouncementSectionLine(line, tone));
    }
}

export function printUpdateAnnouncementSections(result: Record<string, unknown> | null | undefined): void {
    if (!result) {
        return;
    }

    const updateMessages = Array.isArray(result.updateMessages)
        ? result.updateMessages as Array<Record<string, unknown>>
        : [];
    const releaseNotes = Array.isArray(result.releaseNotes)
        ? result.releaseNotes as Array<Record<string, unknown>>
        : [];
    const warnings = toPrintableLines(result.updateAnnouncementWarnings);

    const updateMessageLines = updateMessages.flatMap((entry) => {
        const version = String(entry.version ?? '').trim();
        const title = String(entry.title ?? '').trim();
        const body = toPrintableLines(entry.body);
        if (!version || !title) {
            return [];
        }
        return [
            `  ${version} - ${title}`,
            ...body.map((line) => `    - ${stripMarkdownBulletPrefix(line)}`)
        ];
    });
    const releaseNoteLines = releaseNotes.flatMap((entry) => {
        const version = String(entry.version ?? '').trim();
        const lines = toPrintableLines(entry.lines);
        if (!version || lines.length === 0) {
            return [];
        }
        return [
            `  ${version}`,
            ...lines.map((line) => `    - ${stripMarkdownBulletPrefix(line)}`)
        ];
    });

    printAnnouncementSection('UpdateMessages', updateMessageLines);
    printAnnouncementSection('ReleaseNotes', releaseNoteLines);
    printAnnouncementSection('UpdateAnnouncementWarnings', warnings.map((line) => `- ${line}`), 'warning');
}

export function normalizeYesNo(value: unknown, label: string): string {
    const text = String(value ?? '').trim().toLowerCase();
    if (!text) {
        throw new Error(`${label} must not be empty.`);
    }
    if (text === 'true') {
        return 'yes';
    }
    if (text === 'false') {
        return 'no';
    }
    if (text !== 'yes' && text !== 'no') {
        throw new Error(`${label} must be one of: yes, no (legacy true/false also accepted).`);
    }
    return text;
}

export function getCommandName(argv: string[]): string {
    if (argv.length === 0) {
        return 'bootstrap';
    }
    const candidate = String(argv[0] || '').trim();
    if (candidate === 'help') {
        return 'help';
    }
    if (candidate === 'gate' || LIFECYCLE_COMMANDS.includes(candidate)) {
        return candidate;
    }
    return candidate;
}

export function ensureBundleExists(targetRoot: string, commandName: string): string {
    const bundlePath = getBundlePath(targetRoot);
    if (!fs.existsSync(bundlePath) || !fs.lstatSync(bundlePath).isDirectory()) {
        throw new Error([
            `Deployed bundle not found: ${bundlePath}`,
            `Run 'npx garda-agent-orchestrator' first, then rerun '${commandName}'.`
        ].join('\n'));
    }
    return bundlePath;
}

export function getDefaultInitAnswersPath(targetRoot: string, bundlePath?: string): string {
    const effectiveBundlePath = bundlePath || getBundlePath(targetRoot);
    return path.join(path.basename(effectiveBundlePath), 'runtime', 'init-answers.json');
}

function resolveUpdateHandoffEntry(bundlePath: string): string {
    const bundleRoot = path.resolve(bundlePath);
    if (fs.lstatSync(bundleRoot).isSymbolicLink()) {
        throw new Error('Updated bundle root must not be a filesystem link.');
    }
    const entryPath = path.join(bundleRoot, 'dist', 'src', 'cli', 'commands', 'update-runtime-handoff.js');
    const pending = [path.join(bundleRoot, 'dist')];
    while (pending.length > 0) {
        const current = pending.pop() as string;
        const stats = fs.lstatSync(current);
        if (stats.isSymbolicLink()) {
            throw new Error('Updated bundle runtime contains a filesystem link.');
        }
        if (stats.isDirectory()) {
            pending.push(...fs.readdirSync(current).map((name) => path.join(current, name)));
        }
    }
    const realBundleRoot = fs.realpathSync.native(bundleRoot);
    const realEntryPath = fs.realpathSync.native(entryPath);
    if (!isPathInsideRoot(realBundleRoot, realEntryPath)
        || !fs.lstatSync(entryPath).isFile()
        || !fs.statSync(realEntryPath).isFile()) {
        throw new Error('Updated bundle handoff entry must be a contained regular file.');
    }
    return realEntryPath;
}

function getHandoffEnvironment(): NodeJS.ProcessEnv {
    return Object.fromEntries(Object.entries(process.env).filter(([key]) => (
        !['NODE_OPTIONS', 'NODE_PATH', 'NODE_REPL_EXTERNAL_MODULE', 'GARDA_UPDATE_HANDOFF_INTERNAL_LOADER'].includes(key.toUpperCase())
    )));
}

export function buildUpdateLifecycleRunner(bundlePath: string, fallbackDryRun: boolean | undefined) {
    return function runLifecycleFromCli(runnerOptions: CheckUpdateRunnerOptions): UpdateLifecycleResult {
        // The caller has already synced bundle files before invoking this runner.
        markRuntimeRestartRequired();
        if (!['enforced', 'overridden'].includes(runnerOptions.trustPolicy)) {
            throw new Error('Updated bundle handoff requires a validated update source.');
        }
        let entryPath: string;
        try {
            entryPath = resolveUpdateHandoffEntry(bundlePath);
        } catch (error) {
            throw new Error('Updated bundle handoff entry is missing or escapes the contained bundle.', { cause: error });
        }
        const child = spawnSync(process.execPath, [
            '--require', path.join(__dirname, 'update-runtime-loader-guard.js'), entryPath
        ], {
            input: JSON.stringify({
                bundleRoot: path.resolve(bundlePath),
                runnerOptions: { ...runnerOptions, lifecycleLockAlreadyHeld: true },
                lifecycleLockHandoff: captureLifecycleLockHandoff(runnerOptions.targetRoot),
                fallbackDryRun
            }),
            encoding: 'utf8',
            stdio: ['pipe', 'inherit', 'inherit', 'pipe'],
            env: { ...getHandoffEnvironment(), GARDA_UPDATE_HANDOFF_DIST: path.join(path.resolve(bundlePath), 'dist') },
            windowsHide: true,
            maxBuffer: 16 * 1024 * 1024
        });
        const responseText = child.output?.[3];
        let response: { result?: UpdateLifecycleResult; error?: string } | null = null;
        try {
            response = typeof responseText === 'string' ? JSON.parse(responseText) : null;
        } catch {
            // A missing or invalid frame is a failed handoff, never a reason to run stale code.
        }
        if (child.error || child.status !== 0 || !response?.result) {
            throw new Error(response?.error || child.error?.message || 'Updated bundle lifecycle handoff failed.');
        }
        return response.result;
    };
}

export function mergeUpdateLifecycleOutput(
    baseResult: Record<string, unknown>,
    lifecycleResult: UpdateLifecycleResult | null
): Record<string, unknown> {
    if (!lifecycleResult) {
        return baseResult;
    }
    return {
        ...baseResult,
        previousVersion: lifecycleResult.previousVersion,
        updatedVersion: lifecycleResult.updatedVersion,
        workflowConfigMergeStatus: lifecycleResult.workflowConfigMergeStatus,
        optionalQualityChecksNotice: lifecycleResult.optionalQualityChecksNotice,
        projectMemoryMaintenanceSummaryLine: lifecycleResult.projectMemoryMaintenanceSummaryLine,
        projectMemoryRefreshHandoffPrompt: lifecycleResult.projectMemoryRefreshHandoffPrompt,
        rollbackSnapshotPath: lifecycleResult.rollbackSnapshotPath,
        rollbackStatus: lifecycleResult.rollbackStatus,
        updateReportPath: lifecycleResult.updateReportPath,
        requestedPackageSpec: lifecycleResult.requestedPackageSpec ?? baseResult.requestedPackageSpec,
        exactPackageSpec: lifecycleResult.exactPackageSpec ?? baseResult.exactPackageSpec,
        resolvedPackageVersion: lifecycleResult.resolvedPackageVersion ?? baseResult.resolvedPackageVersion,
        resolvedPackageIntegrity: lifecycleResult.resolvedPackageIntegrity ?? baseResult.resolvedPackageIntegrity,
        releaseProvenanceStatus: lifecycleResult.releaseProvenanceStatus ?? baseResult.releaseProvenanceStatus,
        releaseProvenanceSummary: lifecycleResult.releaseProvenanceSummary ?? baseResult.releaseProvenanceSummary,
        releaseProvenanceRecommendation: lifecycleResult.releaseProvenanceRecommendation ?? baseResult.releaseProvenanceRecommendation,
        gitCommitSha: lifecycleResult.gitCommitSha ?? baseResult.gitCommitSha,
        updateMessages: lifecycleResult.updateMessages,
        releaseNotes: lifecycleResult.releaseNotes,
        updateAnnouncementWarnings: lifecycleResult.updateAnnouncementWarnings
    };
}

function readCurrentBundleVersion(bundlePath: string): string | null {
    const versionPath = path.join(bundlePath, 'VERSION');
    try {
        if (!fs.existsSync(versionPath)) {
            return null;
        }
        const version = fs.readFileSync(versionPath, 'utf8').trim();
        return version || null;
    } catch {
        return null;
    }
}

function compareVersionsSafe(left: string, right: string): number | null {
    try {
        return compareVersionStrings(left, right);
    } catch {
        return null;
    }
}

function resolveAppliedUpdatedVersion(
    result: Record<string, unknown>,
    finalVersion: string | null
): string | null {
    const previousVersion = String(result.previousVersion || result.currentVersion || '').trim();
    const latestVersion = String(result.latestVersion || '').trim();
    const candidates = [
        finalVersion,
        String(result.updatedVersion || '').trim(),
        latestVersion
    ].filter((value): value is string => Boolean(value));
    const selectedVersion = candidates[0] || null;

    if (!previousVersion || !latestVersion) {
        return selectedVersion;
    }

    const latestAfterPrevious = compareVersionsSafe(previousVersion, latestVersion);
    if (latestAfterPrevious === null || latestAfterPrevious >= 0) {
        return selectedVersion;
    }

    if (!selectedVersion) {
        return latestVersion;
    }

    const selectedAfterPrevious = compareVersionsSafe(previousVersion, selectedVersion);
    return selectedAfterPrevious === null || selectedAfterPrevious <= 0
        ? latestVersion
        : selectedVersion;
}

function resolveUpdateReportPath(result: Record<string, unknown>): string | null {
    const updateReportPath = String(result.updateReportPath || '').trim();
    if (!updateReportPath || updateReportPath === 'not-generated-in-dry-run') {
        return null;
    }
    if (path.isAbsolute(updateReportPath)) {
        return updateReportPath;
    }
    const targetRoot = String(result.targetRoot || '').trim();
    return targetRoot ? path.join(targetRoot, updateReportPath) : null;
}

function rewriteUpdateReportUpdatedVersion(result: Record<string, unknown>, updatedVersion: string): void {
    const updateReportPath = resolveUpdateReportPath(result);
    if (!updateReportPath) {
        return;
    }
    try {
        if (!fs.existsSync(updateReportPath) || !fs.statSync(updateReportPath).isFile()) {
            return;
        }
        const reportText = fs.readFileSync(updateReportPath, 'utf8');
        const nextReportText = reportText.replace(
            /^UpdatedVersion:\s.*$/m,
            `UpdatedVersion: ${updatedVersion}`
        );
        if (nextReportText !== reportText) {
            fs.writeFileSync(updateReportPath, nextReportText, 'utf8');
        }
    } catch {
        // Reporting correction is best-effort; primary update success stays authoritative.
    }
}

export function enrichUpdateOutputWithCurrentBundleAnnouncements(
    baseResult: Record<string, unknown>,
    bundlePath: string
): Record<string, unknown> {
    if (baseResult.updateApplied !== true) {
        return baseResult;
    }

    const previousVersion = String(baseResult.previousVersion || '').trim();
    const updatedVersion = String(baseResult.updatedVersion || baseResult.latestVersion || '').trim();
    if (!previousVersion || !updatedVersion) {
        return baseResult;
    }

    const announcements = collectUpdateAnnouncements(bundlePath, previousVersion, updatedVersion);
    return {
        ...baseResult,
        updateMessages: announcements.updateMessages,
        releaseNotes: announcements.releaseNotes,
        updateAnnouncementWarnings: announcements.warnings
    };
}

export function finalizeAppliedUpdateOutput(
    baseResult: Record<string, unknown>,
    bundlePath: string
): Record<string, unknown> {
    if (baseResult.updateApplied !== true) {
        return baseResult;
    }

    const appliedVersion = resolveAppliedUpdatedVersion(baseResult, readCurrentBundleVersion(bundlePath));
    const versionCorrectedResult = appliedVersion
        ? { ...baseResult, updatedVersion: appliedVersion }
        : baseResult;
    if (appliedVersion) {
        rewriteUpdateReportUpdatedVersion(versionCorrectedResult, appliedVersion);
    }
    return enrichUpdateOutputWithCurrentBundleAnnouncements(versionCorrectedResult, bundlePath);
}

export function isFailedValidationResult(result: unknown): result is { passed: false } {
    return result !== null
        && typeof result === 'object'
        && 'passed' in result
        && (result as { passed?: boolean }).passed === false;
}
