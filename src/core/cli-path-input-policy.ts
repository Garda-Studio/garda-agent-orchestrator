import * as path from 'node:path';

import { isPathRealpathInsideRoot } from './paths';

export type CliPathInputClass =
    | 'workspace-contained'
    | 'workspace-expression'
    | 'root-anchor'
    | 'external-allowed'
    | 'contextual'
    | 'path-metadata'
    | 'non-filesystem';

export interface CliPathInputPolicy {
    classification: CliPathInputClass;
    rationale: string;
    splitDelimitedMembers?: boolean;
}

type ParsedOptionValue = string | boolean | string[] | undefined;
type CliOptionDefinitions = Record<string, { key: string; type: string }>;

const workspaceContained = (
    rationale: string,
    options: { splitDelimitedMembers?: boolean } = {}
): CliPathInputPolicy => ({
    classification: 'workspace-contained',
    rationale,
    ...options
});
const nonFilesystem = (rationale: string): CliPathInputPolicy => ({
    classification: 'non-filesystem',
    rationale
});

export const CLI_PATH_INPUT_POLICIES: Readonly<Record<string, CliPathInputPolicy>> = Object.freeze({
    '--active-agent-files': {
        classification: 'path-metadata',
        rationale: 'Allowlisted provider entrypoint names, not arbitrary filesystem reads.'
    },
    '--answers-path': workspaceContained('Reads task-owned answers JSON.'),
    '--artifact-path': workspaceContained('Reads or writes orchestrator-owned gate evidence.'),
    '--bundle-root': {
        classification: 'root-anchor',
        rationale: 'Selects the bundle root and therefore establishes a trust boundary.'
    },
    '--changed-file': workspaceContained('Names one repository scope file; missing files are allowed for deletes.'),
    '--changed-files': workspaceContained(
        'Names a comma-, semicolon-, or newline-delimited repository scope file list; missing files are allowed for deletes.',
        { splitDelimitedMembers: true }
    ),
    '--changed-path': {
        classification: 'path-metadata',
        rationale: 'Optional-skill discovery hint; it is not dereferenced.'
    },
    '--chdir': {
        classification: 'external-allowed',
        rationale: 'Child-process working directory owned by the invoked command contract.'
    },
    '--cli-path': workspaceContained('Attests the repository-owned CLI entrypoint.'),
    '--command-records-path': workspaceContained('Reads task-owned command evidence.'),
    '--compact-file': nonFilesystem('Boolean capability setting for compact file inspection, not a path.'),
    '--commands-path': workspaceContained('Reads repository-owned command policy.'),
    '--compile-evidence-path': workspaceContained('Reads task-owned compile evidence.'),
    '--compile-output-path': workspaceContained('Writes task-owned compile output.'),
    '--correction-artifact-path': workspaceContained('Reads task-owned review-output correction evidence.'),
    '--disposition-artifact-path': workspaceContained('Reads or writes task-owned findings disposition evidence.'),
    '--doc-impact-path': workspaceContained('Reads task-owned documentation impact evidence.'),
    '--events-root': workspaceContained('Reads repository-owned task timelines.'),
    '--fast-path-max-changed-lines': nonFilesystem('Numeric preflight threshold.'),
    '--fast-path-max-files': nonFilesystem('Numeric preflight threshold.'),
    '--focused-required-test-path': workspaceContained('Names a focused repository test target.'),
    '--full-diff-path': workspaceContained('Reads or writes a repository-scoped diff artifact.'),
    '--full-suite-artifact-path': workspaceContained('Reads or writes task-owned full-suite evidence.'),
    '--handshake-path': workspaceContained('Reads task-owned handshake evidence.'),
    '--impact-analysis-path': workspaceContained('Reads task-owned remediation impact evidence.'),
    '--include-path': workspaceContained('Names a repository manifest member.'),
    '--include-paths': workspaceContained(
        'Names comma-, semicolon-, or newline-delimited repository manifest members.',
        { splitDelimitedMembers: true }
    ),
    '--init-answers-path': workspaceContained('Reads workspace-owned initialization answers.'),
    '--keep-task-file': nonFilesystem('Boolean cleanup setting despite the file-shaped name.'),
    '--launch-input-artifact-path': workspaceContained('Reads immutable task-owned reviewer launch input.'),
    '--loaded-rule-file': workspaceContained('Reads a repository-owned rule file.'),
    '--loaded-rule-files': workspaceContained(
        'Reads a comma-, semicolon-, or newline-delimited list of repository-owned rule files.',
        { splitDelimitedMembers: true }
    ),
    '--manifest-path': workspaceContained('Reads or writes a repository-owned manifest.'),
    '--metadata-path': workspaceContained('Reads or writes task-owned metadata.'),
    '--metrics-path': workspaceContained('Writes repository-owned metrics evidence.'),
    '--no-op-artifact-path': workspaceContained('Reads task-owned no-op evidence.'),
    '--ordinary-doc-paths': {
        classification: 'workspace-expression',
        rationale: 'Comma-separated repository-relative paths or globs validated by ordinary-doc policy.'
    },
    '--output-filters-path': workspaceContained('Reads repository-owned output filtering policy.'),
    '--output-path': {
        classification: 'contextual',
        rationale: 'Gate outputs are repository-contained; html report output is explicitly operator-selected and may be external.'
    },
    '--override-artifact-path': workspaceContained('Reads task-owned review override evidence.'),
    '--paths-config-path': workspaceContained('Reads repository-owned path classification policy.'),
    '--plan-path': workspaceContained('Reads a repository-owned task plan.'),
    '--planned-changed-file': workspaceContained('Names a planned repository scope file.'),
    '--planned-changed-files': workspaceContained(
        'Names comma-, semicolon-, or newline-delimited planned repository scope files.',
        { splitDelimitedMembers: true }
    ),
    '--preflight-output-path': workspaceContained('Writes task-owned preflight evidence.'),
    '--preflight-path': workspaceContained('Reads task-owned preflight evidence.'),
    '--profile': nonFilesystem('Profile id, not a filesystem path.'),
    '--receipt-path': workspaceContained('Reads task-owned review receipt evidence.'),
    '--repo-root': {
        classification: 'root-anchor',
        rationale: 'Selects the repository root and establishes the containment boundary.'
    },
    '--review-context-path': workspaceContained('Reads task-owned review context evidence.'),
    '--review-evidence-path': workspaceContained('Reads task-owned review evidence.'),
    '--review-output-path': workspaceContained('Reads delegated reviewer output inside the repository.'),
    '--reviewer-launch-artifact-path': workspaceContained('Reads or writes task-owned reviewer launch control evidence.'),
    '--reviews-root': workspaceContained('Reads repository-owned review evidence.'),
    '--rule-pack-path': workspaceContained('Reads task-owned rule-pack evidence.'),
    '--scope-budget-block-files': nonFilesystem('Numeric scope budget threshold.'),
    '--scope-budget-max-files': nonFilesystem('Numeric scope budget threshold.'),
    '--scope-budget-profiles': nonFilesystem('Comma-separated profile ids.'),
    '--scope-budget-warn-files': nonFilesystem('Numeric scope budget threshold.'),
    '--scoped-diff-metadata-path': workspaceContained('Reads task-owned scoped-diff metadata.'),
    '--shell-smoke-path': workspaceContained('Reads task-owned shell-smoke evidence.'),
    '--skipped-memory-file': workspaceContained('Names one repository-owned project-memory file.'),
    '--skipped-memory-files': workspaceContained('Names repository-owned project-memory files.'),
    '--snapshot-path': {
        classification: 'external-allowed',
        rationale: 'Operator-selected rollback snapshot may live outside the target workspace.'
    },
    '--source-path': {
        classification: 'external-allowed',
        rationale: 'Operator-selected unpacked update bundle is intentionally external to the target workspace.'
    },
    '--target-root': {
        classification: 'root-anchor',
        rationale: 'Selects the target workspace and establishes the containment boundary.'
    },
    '--task-mode-path': workspaceContained('Reads task-owned task-mode evidence.'),
    '--task-profile': nonFilesystem('Profile id, not a filesystem path.'),
    '--timeline-path': workspaceContained('Reads repository-owned task timeline evidence.'),
    '--token-economy-config-path': workspaceContained('Reads repository-owned token-economy policy.'),
    '--update-artifact-path': workspaceContained('Reads task-owned project-memory update evidence.'),
    '--updated-memory-file': workspaceContained('Names one repository-owned project-memory file.'),
    '--updated-memory-files': workspaceContained('Names repository-owned project-memory files.'),
    '--work-package-contract-path': workspaceContained('Reads a repository-owned decomposition contract.')
});

export function isPathShapedCliFlag(flagName: string): boolean {
    return /(?:path|file|dir|root)/u.test(flagName) || flagName === '--chdir';
}

export function getCliPathInputPolicy(flagName: string): CliPathInputPolicy | null {
    return CLI_PATH_INPUT_POLICIES[flagName] || null;
}

function resolveWorkspaceRoot(options: Record<string, ParsedOptionValue>): string {
    const rootValue = options.repoRoot || options.targetRoot || process.cwd();
    return path.resolve(String(rootValue || process.cwd()));
}

export class CliPathContainmentError extends Error {
    constructor(
        readonly flagName: string,
        readonly candidatePath: string,
        readonly workspaceRoot: string,
        message: string
    ) {
        super(message);
        this.name = 'CliPathContainmentError';
    }
}

function buildContainmentError(flagName: string, candidatePath: string, workspaceRoot: string): CliPathContainmentError {
    const normalizedCandidate = path.resolve(candidatePath);
    if (flagName === '--planned-changed-files') {
        return new CliPathContainmentError(
            flagName,
            normalizedCandidate,
            workspaceRoot,
            `PlannedChangedFile must stay inside repo root: ${normalizedCandidate}`
        );
    }
    const diagnosticLabels: Readonly<Record<string, string>> = {
        '--preflight-path': 'PreflightPath',
        '--preflight-output-path': 'PreflightOutputPath',
        '--review-output-path': 'ReviewOutputPath'
    };
    const diagnosticLabel = diagnosticLabels[flagName];
    return new CliPathContainmentError(
        flagName,
        normalizedCandidate,
        workspaceRoot,
        diagnosticLabel
            ? `${diagnosticLabel} must resolve inside repo root without symlink or junction escape: ${normalizedCandidate}`
            : `${flagName} must resolve inside workspace root without symlink or junction escapes: ${workspaceRoot}; candidate=${normalizedCandidate}`
    );
}

function validateContainedValue(flagName: string, rawValue: string, workspaceRoot: string): void {
    const value = rawValue.trim();
    if (!value) {
        return;
    }
    if (value.includes('\0')) {
        throw new Error(`${flagName} contains an invalid null byte.`);
    }
    const isWindowsOnlyAbsolutePath = path.win32.isAbsolute(value)
        && !path.posix.isAbsolute(value);
    if (isWindowsOnlyAbsolutePath && process.platform !== 'win32') {
        throw buildContainmentError(flagName, value, workspaceRoot);
    }
    const resolvedPath = path.isAbsolute(value)
        ? path.resolve(value)
        : path.resolve(workspaceRoot, value);
    if (!isPathRealpathInsideRoot(workspaceRoot, resolvedPath, { allowMissing: true })) {
        throw buildContainmentError(flagName, resolvedPath, workspaceRoot);
    }
}

export function validateParsedCliPathInputs(
    definitions: CliOptionDefinitions,
    options: Record<string, ParsedOptionValue>
): void {
    const workspaceRoot = resolveWorkspaceRoot(options);
    const validatedValues = new Set<string>();
    for (const [flagName, definition] of Object.entries(definitions)) {
        if (!isPathShapedCliFlag(flagName)) {
            continue;
        }
        const policy = getCliPathInputPolicy(flagName);
        if (!policy) {
            throw new Error(`Unclassified CLI path input: ${flagName}. Add an explicit path-input policy.`);
        }
        if (policy.classification !== 'workspace-contained') {
            continue;
        }
        const optionValue = options[definition.key];
        const values = Array.isArray(optionValue) ? optionValue : [optionValue];
        for (const rawValue of values) {
            if (typeof rawValue !== 'string') {
                continue;
            }
            const members = policy.splitDelimitedMembers
                ? rawValue.split(/[\r\n,;]+/u)
                : [rawValue];
            for (const member of members) {
                const validationKey = `${definition.key}\0${member}`;
                if (validatedValues.has(validationKey)) {
                    continue;
                }
                validatedValues.add(validationKey);
                validateContainedValue(flagName, member, workspaceRoot);
            }
        }
    }
}
