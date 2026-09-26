import * as crypto from 'node:crypto';
import * as path from 'node:path';

import { getRepoRoot } from '../build';
import { hasReviewedSecurityWorkflow, validateCandidateReadiness, type CandidateReadinessRequest, type CandidateReadinessDependencies } from './candidate-readiness';
export { parseCandidateReadinessArgs } from './candidate-readiness';
import {
    FORBIDDEN_PUBLISHED_PACKAGE_SURFACE_ITEMS,
    PUBLISHED_PACKAGE_SURFACE_ITEMS,
    PUBLIC_PACKAGE_DOC_ITEMS,
    RELEASE_READINESS_CHECKLIST_PATH,
    SECURITY_RELEASE_DOC_ITEMS,
    type ReleaseReadinessCheck,
    type ReleaseReadinessResult
} from './types';
import {
    countOccurrences,
    escapeRegExp,
    fileExists,
    getStringArray,
    getStringRecord,
    isGitTracked,
    manifestListsEvery,
    pushCheck,
    readPackageJsonObject,
    readTextFileIfExists
} from './shared';
import { PACKAGE_SURFACE_BASELINE_PATH } from './package-surface-types';
import { parsePackageSurfaceBaseline } from './package-surface-baseline';
import {
    validateChangelogReleaseSection,
    validateReleaseTagAssignment,
    validateTrackedMarkdownLinks
} from './release-metadata';

const TRUSTED_RELEASE_TAG_HISTORY_STEP_SHA256 = 'dd86883aee9e6eef46c76a284d9a90431073efaecdd74adcce97f4e53223b470';
const TRUSTED_RELEASE_CANDIDATE_PUBLISH_STEPS_SHA256 = '26b8e7c2f66cd01ae719d68cc3836566164362e429d62181dad7e4039fa8590f';
const TRUSTED_RELEASE_CI_PROOF_STEP_SHA256 = '6babce8ec31d4a33df128186cbf02f604e2b7777c8d7801a296c4216a6d7b10f';
const TRUSTED_RELEASE_CANDIDATE_PACK_STEP_SHA256 = 'f62df6d8ca1b684eb8bfaede8763254ae4da5488464b053095d0b6891b27de39';
const TRUSTED_RELEASE_PUBLISH_JOB_SHA256 = 'f9258da3a0dfa441cddcfc7f0be1c37338e6096900012accdf0d107b91646c2b';
// Bind all release jobs, workflow permissions, and immutable action pins.
const TRUSTED_RELEASE_WORKFLOW_SHA256 = 'e2d391fffc786c0cd9c61ce2b8e1770fa302d5a1772c7c6069da475bb184a188';
// Hash the source workflow before action-reference normalization so the immutable pins remain bound.
const TRUSTED_SBOM_WORKFLOW_CONTRACT_SHA256 = '2d88c5db2ead8b460476af6b9539a7a8544c25f16bb4376083e82ff2687db05c';
const REVIEWED_WORKFLOW_ACTION_PINS: Readonly<Record<string, { version: string; readinessReference: string }>> = {
    'actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0': {
        version: 'v7.0.0',
        readinessReference: 'actions/checkout@v7.0.0'
    },
    'actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38': {
        version: 'v6.5.0',
        readinessReference: 'actions/setup-node@v6'
    },
    'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a': {
        version: 'v7.0.1',
        readinessReference: 'actions/upload-artifact@v7.0.1'
    },
    'google/osv-scanner-action/.github/workflows/osv-scanner-reusable.yml@b77c075a1235514558f0eb88dbd31e22c45e0cd2': {
        version: 'v2.3.0',
        readinessReference: 'google/osv-scanner-action/.github/workflows/osv-scanner-reusable.yml@v2.3.0'
    }
};
interface WorkflowUseReference {
    lineIndex: number;
    line: string;
    reference: string;
    versionComment: string;
}

function readWorkflowForReadiness(repoRoot: string, fileName: string): string {
    const workflow = readTextFileIfExists(path.join(repoRoot, '.github', 'workflows', fileName)) || '';
    const scanner = require(path.join(getRepoRoot(), 'scripts', 'validate-workflow-references.cjs')) as {
        scanWorkflowUses: (content: string) => WorkflowUseReference[];
    };
    const lines = workflow.split(/(\r?\n)/u);
    for (const use of scanner.scanWorkflowUses(workflow)) {
        const reviewedPin = REVIEWED_WORKFLOW_ACTION_PINS[use.reference];
        if (reviewedPin?.version !== use.versionComment) {
            continue;
        }
        const prefix = /^([ \t]*(?:-[ \t]+)?(?:uses|'uses'|"uses")[ \t]*:[ \t]*)/u.exec(use.line)?.[1];
        if (prefix) {
            lines[use.lineIndex * 2] = `${prefix.replace(/(?:'uses'|"uses")(?=[ \t]*:)/u, 'uses')}${reviewedPin.readinessReference}`;
        }
    }
    return lines.join('');
}

const TRUSTED_GITLEAKS_JOB_CONTRACT = [
    'gitleaks:',
    '  name: Gitleaks',
    '  runs-on: ubuntu-latest',
    '  steps:',
    '    - uses: actions/checkout@v7.0.0',
    '      with:',
    '        fetch-depth: 0',
    '    - name: Install Gitleaks CLI',
    '      shell: bash',
    '      env:',
    "        GITLEAKS_VERSION: '8.30.1'",
    "        GITLEAKS_SHA256: '551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb'",
    '      run: |',
    '        set -euo pipefail',
    '        install_dir="$(mktemp -d "${RUNNER_TEMP}/gitleaks.XXXXXX")"',
    '        archive="gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz"',
    '        curl --fail --silent --show-error --location --retry 3 \\',
    '          "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/${archive}" \\',
    '          --output "${install_dir}/${archive}"',
    "        printf '%s  %s\\n' \"$GITLEAKS_SHA256\" \"${install_dir}/${archive}\" | sha256sum --check --strict",
    '        tar -xzf "${install_dir}/${archive}" -C "$install_dir" gitleaks',
    '        chmod +x "${install_dir}/gitleaks"',
    '        echo "$install_dir" >> "$GITHUB_PATH"',
    '    - name: Scan for secrets',
    '      shell: bash',
    '      run: gitleaks git --config .gitleaks.toml --redact --exit-code 1 .'
].join('\n');

const TRUSTED_SBOM_IDENTITY_STEP_CONTRACT = [
    '- name: Record SBOM toolchain identity',
    '  shell: bash',
    '  run: |',
    "    node - <<'NODE' > sbom-toolchain.json",
    "    const { createHash } = require('node:crypto');",
    "    const { readFileSync } = require('node:fs');",
    "    const manifest = require('./package.json');",
    "    const lock = require('./package-lock.json');",
    "    const installed = require('./node_modules/@cyclonedx/cyclonedx-npm/package.json');",
    "    const locked = lock.packages['node_modules/@cyclonedx/cyclonedx-npm'];",
    "    if (!locked?.integrity || manifest.devDependencies['@cyclonedx/cyclonedx-npm'] !== installed.version || locked.version !== installed.version) {",
    "      throw new Error('SBOM generator does not match the locked dev dependency');",
    '    }',
    "    const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');",
    '    process.stdout.write(JSON.stringify({',
    '      generator: { name: installed.name, version: installed.version, integrity: locked.integrity },',
    "      lockfile_sha256: sha256('package-lock.json'),",
    "      sbom_sha256: sha256('sbom.cdx.json')",
    "    }, null, 2) + '\\n');",
    '    NODE'
].join('\n');

function extractReleaseChecklistItems(checklistMarkdown: string, version: string): {
    releaseChecklistItems: string[];
    openReleaseChecklistItems: string[];
} {
    const releaseChecklistItems: string[] = [];
    const openReleaseChecklistItems: string[] = [];
    let inVersionSection = false;
    const sectionPattern = new RegExp(`^##\\s+${escapeRegExp(version)}(?:\\s|$)`, 'u');

    for (const line of checklistMarkdown.split(/\r?\n/u)) {
        if (sectionPattern.test(line)) {
            inVersionSection = true;
            continue;
        }
        if (inVersionSection && /^##\s+/u.test(line)) {
            break;
        }
        if (!inVersionSection) {
            continue;
        }

        const match = line.match(/^-\s+\[([xX ])\]\s+(.+?)\s*$/u);
        if (!match) {
            continue;
        }
        const item = match[2];
        releaseChecklistItems.push(item);
        if (match[1] === ' ') {
            openReleaseChecklistItems.push(item);
        }
    }

    return { releaseChecklistItems, openReleaseChecklistItems };
}

function validateReleaseChecklist(repoRoot: string, version: string | null): {
    releaseChecklistItems: string[];
    openReleaseChecklistItems: string[];
    details: string[];
} {
    const checklistPath = path.join(repoRoot, ...RELEASE_READINESS_CHECKLIST_PATH.split('/'));
    const checklistMarkdown = readTextFileIfExists(checklistPath);
    if (checklistMarkdown === null) {
        return {
            releaseChecklistItems: [],
            openReleaseChecklistItems: [],
            details: [`Missing tracked release checklist: ${RELEASE_READINESS_CHECKLIST_PATH}`]
        };
    }
    if (!isGitTracked(repoRoot, RELEASE_READINESS_CHECKLIST_PATH)) {
        return {
            releaseChecklistItems: [],
            openReleaseChecklistItems: [],
            details: [`Untracked release checklist: ${RELEASE_READINESS_CHECKLIST_PATH}`]
        };
    }

    const targetVersion = version || 'unknown';
    const { releaseChecklistItems, openReleaseChecklistItems } = extractReleaseChecklistItems(
        checklistMarkdown,
        targetVersion
    );
    const details = [
        `Release ${targetVersion} checklist items: ${releaseChecklistItems.length}`,
        `Open checklist items: ${openReleaseChecklistItems.length === 0 ? 'none' : openReleaseChecklistItems.join('; ')}`
    ];

    if (releaseChecklistItems.length === 0) {
        details.push(`No checklist items were found in the Release ${targetVersion} section.`);
    }

    return { releaseChecklistItems, openReleaseChecklistItems, details };
}

function getWorkflowJobBlock(workflowText: string, jobId: string): string | null {
    const lines = workflowText.split(/\r?\n/u);
    const jobPattern = new RegExp(`^(\\s*)${escapeRegExp(jobId)}:\\s*$`, 'u');
    const jobStart = lines.findIndex((line) => jobPattern.test(line));
    if (jobStart === -1) {
        return null;
    }
    const jobIndent = jobPattern.exec(lines[jobStart])![1].length;
    const nextJobPattern = new RegExp(`^\\s{${jobIndent}}[A-Za-z0-9_-]+:\\s*$`, 'u');
    const nextJob = lines.findIndex((line, index) => index > jobStart && nextJobPattern.test(line));
    return lines.slice(jobStart, nextJob === -1 ? undefined : nextJob).join('\n');
}

function getWorkflowJobBlockUnderJobs(workflowText: string, jobId: string): string | null {
    const lines = workflowText.split(/\r?\n/u);
    const jobsStart = lines.findIndex((line) => /^jobs:\s*$/u.test(line));
    if (jobsStart === -1) {
        return null;
    }

    let jobsEnd = lines.length;
    for (let index = jobsStart + 1; index < lines.length; index += 1) {
        const line = lines[index];
        if (!line.trim() || /^\s*#/u.test(line)) {
            continue;
        }
        if (line.match(/^\s*/u)![0].length === 0) {
            jobsEnd = index;
            break;
        }
    }

    const directJobPattern = /^\s+([A-Za-z0-9_-]+):\s*$/u;
    const directJobLines = lines
        .slice(jobsStart + 1, jobsEnd)
        .map((line, relativeIndex) => ({ line, index: jobsStart + 1 + relativeIndex }))
        .filter(({ line }) => directJobPattern.test(line));
    if (directJobLines.length === 0) {
        return null;
    }
    const jobIndent = Math.min(...directJobLines.map(({ line }) => line.match(/^\s*/u)![0].length));
    const jobPattern = new RegExp(`^\\s{${jobIndent}}${escapeRegExp(jobId)}:\\s*$`, 'u');
    const jobStart = directJobLines.find(({ line }) => jobPattern.test(line))?.index ?? -1;
    if (jobStart === -1) {
        return null;
    }

    let jobEnd = jobsEnd;
    for (let index = jobStart + 1; index < jobsEnd; index += 1) {
        const line = lines[index];
        if (!line.trim() || /^\s*#/u.test(line)) {
            continue;
        }
        if (line.match(/^\s*/u)![0].length <= jobIndent) {
            jobEnd = index;
            break;
        }
    }
    return lines.slice(jobStart, jobEnd).join('\n');
}

function getWorkflowNamedStepBlock(workflowText: string, stepName: string): string | null {
    const lines = workflowText.split(/\r?\n/u);
    const stepStart = lines.findIndex((line) => {
        const match = /^(\s*)-\s+name:\s*(.+?)\s*$/u.exec(line);
        return match !== null && stripYamlQuotes(match[2].trim()) === stepName;
    });
    if (stepStart === -1) {
        return null;
    }

    const stepIndent = lines[stepStart].match(/^\s*/u)![0].length;
    let stepEnd = lines.length;
    for (let index = stepStart + 1; index < lines.length; index += 1) {
        const line = lines[index];
        if (!line.trim()) {
            continue;
        }
        const lineIndent = line.match(/^\s*/u)![0].length;
        if (lineIndent < stepIndent || (lineIndent === stepIndent && /^\s*-\s+/u.test(line))) {
            stepEnd = index;
            break;
        }
    }
    return lines.slice(stepStart, stepEnd).join('\n');
}

function workflowBlockContractSha256(block: string | null): string | null {
    if (block === null) {
        return null;
    }
    const normalized = block.split(/\r?\n/u)
        .map((line) => line.trim())
        .filter((line) => line !== '' && !line.startsWith('#'))
        .join('\n');
    return crypto.createHash('sha256').update(normalized).digest('hex');
}

function workflowStructuralBlockContractSha256(block: string | null): string | null {
    if (block === null) {
        return null;
    }
    const contractLines = block.split(/\r?\n/u)
        .filter((line) => line.trim() !== '' && !line.trimStart().startsWith('#'));
    const baseIndent = contractLines[0]?.match(/^\s*/u)?.[0].length ?? 0;
    const normalized = contractLines
        .map((line) => line.slice(baseIndent).trimEnd())
        .join('\n');
    return crypto.createHash('sha256').update(normalized).digest('hex');
}

function extractYamlListAfterKey(block: string | null, key: string): string[] {
    if (block === null) {
        return [];
    }
    const lines = block.split(/\r?\n/u);
    const keyPattern = new RegExp(`^(\\s*)${key}:\\s*$`, 'u');
    const keyIndex = lines.findIndex((line) => keyPattern.test(line));
    if (keyIndex === -1) {
        return [];
    }
    const keyIndent = keyPattern.exec(lines[keyIndex])![1].length;
    const values: string[] = [];
    for (const line of lines.slice(keyIndex + 1)) {
        const indent = line.match(/^\s*/u)![0].length;
        if (line.trim() && indent <= keyIndent) {
            break;
        }
        const item = /^\s*-\s*(.+?)\s*$/u.exec(line);
        if (item) {
            values.push(item[1].replace(/^['"]|['"]$/gu, ''));
        }
    }
    return values;
}

function getYamlDirectChildBlock(block: string | null, key: string): string | null {
    if (block === null) {
        return null;
    }
    const lines = block.split(/\r?\n/u);
    const parentLineIndex = lines.findIndex((line) => line.trim() !== '');
    if (parentLineIndex === -1) {
        return null;
    }
    const parentIndent = lines[parentLineIndex].match(/^\s*/u)![0].length;
    const childIndent = lines.slice(parentLineIndex + 1)
        .map((line) => ({ line, indent: line.match(/^\s*/u)![0].length }))
        .find(({ line, indent }) => line.trim() !== '' && indent > parentIndent)?.indent;
    if (childIndent === undefined) {
        return null;
    }

    const keyPattern = new RegExp(`^\\s{${childIndent}}${key}:\\s*(?:[|>][+-]?)?\\s*$`, 'u');
    const keyIndex = lines.findIndex((line, index) => index > parentLineIndex && keyPattern.test(line));
    if (keyIndex === -1) {
        return null;
    }

    let endIndex = lines.length;
    for (let index = keyIndex + 1; index < lines.length; index += 1) {
        const line = lines[index];
        if (line.trim() && line.match(/^\s*/u)![0].length <= childIndent) {
            endIndex = index;
            break;
        }
    }
    return lines.slice(keyIndex, endIndex).join('\n');
}

function stringArraysEqual(left: readonly string[], right: readonly string[]): boolean {
    return left.length === right.length && left.every((value, index) => value === right[index]);
}

function workflowJobHasRunStep(block: string | null, command: string): boolean {
    if (block === null) {
        return false;
    }
    const runScripts = extractWorkflowRunScripts(block);
    return runScripts.some((script) => scriptHasExecutableCommand(script, command));
}

function workflowJobHasExactRunLine(block: string | null, command: string): boolean {
    if (block === null) {
        return false;
    }
    return extractWorkflowRunScripts(block)
        .some((script) => extractExecutableScriptLines(script).some((line) => line === command));
}

function workflowRunScriptsIncludeAll(runScripts: readonly string[], requiredMarkers: readonly string[]): boolean {
    return runScripts.some((script) => {
        const executableLines = extractExecutableScriptLines(script);
        return requiredMarkers.every((marker) => executableLines.some((line) => executableLineContainsMarker(line, marker)));
    });
}

function workflowRunScriptsIncludeExecutableMarkers(
    runScripts: readonly string[],
    requiredMarkers: readonly string[]
): boolean {
    return runScripts.some((script) => {
        const executableLines = extractExecutableScriptLines(script);
        return scriptPreservesFailureExit(executableLines)
            && requiredMarkers.every((marker) => executableLines.some((line) => executableLineContainsMarker(line, marker)));
    });
}

function workflowRunScriptsIncludeExecutableMarkersInOrder(
    runScripts: readonly string[],
    requiredMarkers: readonly string[]
): boolean {
    return runScripts.some((script) => {
        const executableLines = extractExecutableScriptLines(script);
        if (!scriptPreservesFailureExit(executableLines)) return false;
        let nextLine = 0;
        return requiredMarkers.every((marker) => {
            const index = executableLines.findIndex((line, lineIndex) =>
                lineIndex >= nextLine && executableLineContainsMarker(line, marker));
            if (index < 0) return false;
            nextLine = index + 1;
            return true;
        });
    });
}

function scriptPreservesFailureExit(lines: readonly string[]): boolean {
    return lines[0] === 'set -euo pipefail'
        && lines.every((line) => !/(?:\|\||;|\bset\s+\+e\b|\bset\s+\+o\s+errexit\b)/u.test(line));
}

function executableLineContainsMarker(line: string, marker: string): boolean {
    return !isShellTextOnlyCommand(line)
        && extractHereDocTerminator(line) === null
        && line.includes(marker);
}

function isShellTextOnlyCommand(line: string): boolean {
    const withoutLeadingAssignments = line.replace(
        /^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s]+)\s+)*/u,
        ''
    );
    return /^(?:echo|printf)\b/u.test(withoutLeadingAssignments);
}

function workflowHasUseStep(workflowText: string, actionReference: string): boolean {
    for (const line of workflowText.split(/\r?\n/u)) {
        const match = /^\s*(?:-\s*)?uses:\s*(.+?)\s*$/u.exec(line);
        if (!match) {
            continue;
        }
        if (stripYamlQuotes(match[1].trim()) === actionReference) {
            return true;
        }
    }
    return false;
}

function getYamlKeyBlock(block: string | null, key: string): string | null {
    if (block === null) {
        return null;
    }
    const lines = block.split(/\r?\n/u);
    const keyPattern = new RegExp(`^(\\s*)${key}:\\s*(?:[|>][+-]?)?\\s*$`, 'u');
    const keyIndex = lines.findIndex((line) => keyPattern.test(line));
    if (keyIndex === -1) {
        return null;
    }
    const keyIndent = keyPattern.exec(lines[keyIndex])![1].length;
    let endIndex = lines.length;
    for (let index = keyIndex + 1; index < lines.length; index += 1) {
        const line = lines[index];
        if (line.trim() && line.match(/^\s*/u)![0].length <= keyIndent) {
            endIndex = index;
            break;
        }
    }
    return lines.slice(keyIndex, endIndex).join('\n');
}

function getWorkflowUseStepBlock(workflowText: string, actionReference: string): string | null {
    const lines = workflowText.split(/\r?\n/u);

    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        const usesMatch = /^(\s*)(?:-\s*)?uses:\s*(.+?)\s*$/u.exec(line);
        if (!usesMatch || stripYamlQuotes(usesMatch[2].trim()) !== actionReference) {
            continue;
        }

        const usesIndent = usesMatch[1].length;
        const inlineStepMatch = /^(\s*)-\s+uses:/u.exec(line);
        let stepStart = inlineStepMatch ? index : -1;
        let stepIndent = inlineStepMatch ? inlineStepMatch[1].length : -1;
        for (let previousIndex = index - 1; stepStart === -1 && previousIndex >= 0; previousIndex -= 1) {
            const previousLine = lines[previousIndex];
            const previousStep = /^(\s*)-\s+/u.exec(previousLine);
            if (previousStep && previousStep[1].length < usesIndent) {
                stepStart = previousIndex;
                stepIndent = previousStep[1].length;
            }
        }
        if (stepStart === -1) {
            return null;
        }

        let stepEnd = lines.length;
        for (let nextIndex = stepStart + 1; nextIndex < lines.length; nextIndex += 1) {
            const nextLine = lines[nextIndex];
            if (nextLine.trim() && nextLine.match(/^\s*/u)![0].length <= stepIndent) {
                stepEnd = nextIndex;
                break;
            }
        }
        return lines.slice(stepStart, stepEnd).join('\n');
    }

    return null;
}

function blockHasNonCommentLine(block: string | null, expectedLine: string): boolean {
    return (block || '').split(/\r?\n/u)
        .some((line) => {
            const trimmed = line.trim();
            return trimmed !== '' && !trimmed.startsWith('#') && trimmed === expectedLine;
        });
}

function yamlBlockHasScalarValue(block: string | null, key: string, allowedValues: readonly string[]): boolean {
    if (block === null) {
        return false;
    }
    const keyPattern = new RegExp(`^\\s*${key}:\\s*(.+?)\\s*$`, 'u');
    return block.split(/\r?\n/u).some((line) => {
        const trimmed = line.trim();
        if (trimmed === '' || trimmed.startsWith('#')) {
            return false;
        }
        const match = keyPattern.exec(trimmed);
        return match !== null && allowedValues.includes(stripYamlQuotes(match[1].trim()));
    });
}

function scriptHasExecutableCommand(script: string, command: string): boolean {
    return extractExecutableScriptLines(script)
        .some((line) => line === command || line.startsWith(`${command} `));
}

function extractExecutableScriptLines(script: string): string[] {
    let hereDocTerminator: string | null = null;
    const executableLines: string[] = [];

    for (const line of script.split(/\r?\n/u)) {
        const trimmedLine = line.trim();
        if (hereDocTerminator !== null) {
            if (trimmedLine === hereDocTerminator) {
                hereDocTerminator = null;
            }
            continue;
        }
        if (!trimmedLine || trimmedLine.startsWith('#')) {
            continue;
        }
        executableLines.push(trimmedLine);
        hereDocTerminator = extractHereDocTerminator(trimmedLine);
    }

    return executableLines;
}

function extractHereDocTerminator(line: string): string | null {
    const match = /(?:^|\s)<<-?\s*(?:'([^']+)'|"([^"]+)"|([A-Za-z_][A-Za-z0-9_.-]*))/u.exec(line);
    return match ? match[1] || match[2] || match[3] : null;
}

function extractWorkflowRunScripts(block: string): string[] {
    const scripts: string[] = [];
    const lines = block.split(/\r?\n/u);

    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        const inlineRun = /^(\s*)-\s+run:\s*(.+?)\s*$/u.exec(line)
            || /^(\s*)run:\s*(.+?)\s*$/u.exec(line);
        if (!inlineRun) {
            continue;
        }

        const runIndent = inlineRun[1].length;
        const runValue = inlineRun[2].trim();
        if (!/^[|>][+-]?$/u.test(runValue)) {
            scripts.push(stripYamlQuotes(runValue));
            continue;
        }

        const scriptLines: string[] = [];
        for (let nextIndex = index + 1; nextIndex < lines.length; nextIndex += 1) {
            const nextLine = lines[nextIndex];
            if (nextLine.trim() && nextLine.match(/^\s*/u)![0].length <= runIndent) {
                break;
            }
            scriptLines.push(nextLine.trim());
            index = nextIndex;
        }
        scripts.push(scriptLines.join('\n'));
    }

    return scripts;
}

function stripYamlQuotes(value: string): string {
    return value.replace(/^['"]|['"]$/gu, '');
}

function validateCiRuntimeMatrixContract(ciWorkflow: string): { passed: boolean; details: string[] } {
    const releaseJob = getWorkflowJobBlock(ciWorkflow, 'validate-release');
    const smokeJob = getWorkflowJobBlock(ciWorkflow, 'smoke');
    const testUnitJob = getWorkflowJobBlock(ciWorkflow, 'test-unit');
    const testGatesJob = getWorkflowJobBlock(ciWorkflow, 'test-gates');
    const testCliJob = getWorkflowJobBlock(ciWorkflow, 'test-cli');
    const testLifecycleJob = getWorkflowJobBlock(ciWorkflow, 'test-lifecycle');
    const testBinJob = getWorkflowJobBlock(ciWorkflow, 'test-bin');
    const supportedNodeLines = ['22.13.0', '24'];
    const releaseOsLines = ['ubuntu-latest', 'windows-latest'];
    const smokeOsLines = ['ubuntu-latest', 'windows-latest', 'macos-latest'];
    const releaseNodeVersions = extractYamlListAfterKey(releaseJob, 'node-version');
    const smokeNodeVersions = extractYamlListAfterKey(smokeJob, 'node-version');
    const releaseOsVersions = extractYamlListAfterKey(releaseJob, 'os');
    const smokeOsVersions = extractYamlListAfterKey(smokeJob, 'os');
    const testUnitOk = testUnitJob !== null
        && stringArraysEqual(extractYamlListAfterKey(testUnitJob, 'node-version'), supportedNodeLines);
    const testGatesOk = testGatesJob !== null
        && stringArraysEqual(extractYamlListAfterKey(testGatesJob, 'node-version'), supportedNodeLines)
        && testGatesJob.includes('GARDA_NODE_FOUNDATION_TEST_SHARDS');
    const testCliOk = testCliJob !== null
        && stringArraysEqual(extractYamlListAfterKey(testCliJob, 'node-version'), supportedNodeLines)
        && testCliJob.includes('GARDA_NODE_FOUNDATION_TEST_SHARDS');
    const testLifecycleOk = testLifecycleJob !== null
        && stringArraysEqual(extractYamlListAfterKey(testLifecycleJob, 'node-version'), supportedNodeLines);
    const testBinOk = testBinJob !== null
        && stringArraysEqual(extractYamlListAfterKey(testBinJob, 'node-version'), supportedNodeLines);
    const releaseMatrixOk = stringArraysEqual(releaseNodeVersions, supportedNodeLines)
        && stringArraysEqual(releaseOsVersions, releaseOsLines)
        && (workflowJobHasRunStep(releaseJob, 'npm run validate:release:fast') || workflowJobHasRunStep(releaseJob, 'npm run validate:release'));
    const smokeMatrixOk = stringArraysEqual(smokeNodeVersions, supportedNodeLines)
        && stringArraysEqual(smokeOsVersions, smokeOsLines)
        && workflowJobHasRunStep(smokeJob, '$CLI setup')
        && workflowJobHasRunStep(smokeJob, '$CLI update git')
        && workflowJobHasRunStep(smokeJob, '$CLI doctor')
        && workflowJobHasRunStep(smokeJob, '$CLI uninstall');
    return {
        passed: releaseMatrixOk && smokeMatrixOk && testUnitOk && testGatesOk && testCliOk && testLifecycleOk && testBinOk,
        details: [
            `test-unit present=${testUnitOk}`,
            `test-gates present+sharded=${testGatesOk}`,
            `test-cli present+sharded=${testCliOk}`,
            `test-lifecycle present=${testLifecycleOk}`,
            `test-bin present=${testBinOk}`,
            `validate-release node-version=${releaseNodeVersions.join(', ') || 'missing'}`,
            `validate-release os=${releaseOsVersions.join(', ') || 'missing'}`,
            `smoke node-version=${smokeNodeVersions.join(', ') || 'missing'}`,
            `smoke os=${smokeOsVersions.join(', ') || 'missing'}`
        ]
    };
}

function validateSecurityCiBaselineContract(repoRoot: string): { passed: boolean; details: string[] } {
    const securityWorkflow = readWorkflowForReadiness(repoRoot, 'security.yml');
    const secretScanningWorkflow = readWorkflowForReadiness(repoRoot, 'secret-scanning.yml');
    const sbomSourceWorkflow = readTextFileIfExists(path.join(repoRoot, '.github', 'workflows', 'sbom.yml')) || '';
    const sbomWorkflow = readWorkflowForReadiness(repoRoot, 'sbom.yml');
    const branchProtection = readTextFileIfExists(path.join(repoRoot, 'docs', 'branch-protection.md')) || '';

    const npmAuditBlocking = extractWorkflowRunScripts(securityWorkflow)
        .some((script) => scriptHasExecutableCommand(script, 'npm audit --audit-level=high --no-fund'))
        || hasReviewedSecurityWorkflow(repoRoot);
    const osvScanJob = getWorkflowJobBlock(securityWorkflow, 'osv-scan');
    const osvScanArgsBlock = getYamlKeyBlock(getYamlKeyBlock(osvScanJob, 'with'), 'scan-args');
    const osvInformational = workflowHasUseStep(
        osvScanJob || '',
        'google/osv-scanner-action/.github/workflows/osv-scanner-reusable.yml@v2.3.0'
    )
        && blockHasNonCommentLine(osvScanArgsBlock, '--lockfile=package-lock.json');
    const gitleaksJob = getWorkflowJobBlockUnderJobs(secretScanningWorkflow, 'gitleaks');
    const gitleaksBlocking = workflowStructuralBlockContractSha256(gitleaksJob)
        === workflowStructuralBlockContractSha256(TRUSTED_GITLEAKS_JOB_CONTRACT);
    let sbomToolLocked = false;
    try {
        const manifest = JSON.parse(readTextFileIfExists(path.join(repoRoot, 'package.json')) || 'null');
        const lock = JSON.parse(readTextFileIfExists(path.join(repoRoot, 'package-lock.json')) || 'null');
        const declaredVersion = manifest?.devDependencies?.['@cyclonedx/cyclonedx-npm'];
        const lockedVersion = lock?.packages?.['node_modules/@cyclonedx/cyclonedx-npm']?.version;
        const lockedIntegrity = lock?.packages?.['node_modules/@cyclonedx/cyclonedx-npm']?.integrity;
        sbomToolLocked = typeof declaredVersion === 'string'
            && /^\d+\.\d+\.\d+$/u.test(declaredVersion)
            && lock?.packages?.['']?.devDependencies?.['@cyclonedx/cyclonedx-npm'] === declaredVersion
            && lockedVersion === declaredVersion
            && typeof lockedIntegrity === 'string'
            && /^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(lockedIntegrity)
            && manifest?.scripts?.['sbom:generate'] === 'cyclonedx-npm --output-file sbom.cdx.json --spec-version 1.5 --output-reproducible';
    } catch {
        sbomToolLocked = false;
    }
    const uploadArtifactStep = getWorkflowUseStepBlock(sbomWorkflow, 'actions/upload-artifact@v7.0.1');
    const sbomInstallStep = getWorkflowNamedStepBlock(sbomWorkflow, 'Install dependencies');
    const sbomGenerateStep = getWorkflowNamedStepBlock(sbomWorkflow, 'Generate CycloneDX SBOM');
    const identityStep = getWorkflowNamedStepBlock(sbomWorkflow, 'Record SBOM toolchain identity');
    const sbomRunScripts = extractWorkflowRunScripts(sbomWorkflow);
    const sbomInstallSafe = workflowStructuralBlockContractSha256(sbomInstallStep)
        === workflowStructuralBlockContractSha256('- name: Install dependencies\n  run: npm ci --ignore-scripts --no-fund --no-audit');
    const sbomGenerateLocal = workflowStructuralBlockContractSha256(sbomGenerateStep)
        === workflowStructuralBlockContractSha256('- name: Generate CycloneDX SBOM\n  run: npm run sbom:generate');
    const sbomUploadWith = getYamlKeyBlock(uploadArtifactStep, 'with');
    const identityRecorded = workflowStructuralBlockContractSha256(identityStep)
        === workflowStructuralBlockContractSha256(TRUSTED_SBOM_IDENTITY_STEP_CONTRACT);
    const sbomInformational = sbomToolLocked
        && workflowStructuralBlockContractSha256(sbomSourceWorkflow) === TRUSTED_SBOM_WORKFLOW_CONTRACT_SHA256
        && sbomInstallSafe
        && sbomGenerateLocal
        && sbomRunScripts.length === 3
        && identityRecorded
        && uploadArtifactStep !== null
        && blockHasNonCommentLine(getYamlKeyBlock(sbomUploadWith, 'path'), 'sbom.cdx.json')
        && blockHasNonCommentLine(getYamlKeyBlock(sbomUploadWith, 'path'), 'sbom-toolchain.json')
        && blockHasNonCommentLine(sbomUploadWith, 'if-no-files-found: error');
    const requiredCheckGuidance = [
        'Release Security Required Checks',
        '| `CI` / release validation matrix | `blocking` |',
        '| `Security / npm audit` | `blocking` |',
        '| `Secret Scanning / Gitleaks` | `blocking` |',
        '| `Security / OSV Vulnerability Scan` | `informational` |',
        '| `SBOM / Generate SBOM` | `informational` |'
    ].every((marker) => branchProtection.includes(marker));
    const actionPinningDecision = [
        'GitHub Action pinning decision',
        'version-tag pinned',
        'not SHA-pinned',
        'future provenance or release-signing work'
    ].every((marker) => branchProtection.includes(marker));
    const updateSourcePolicyReporting = [
        'Update-source policy reporting',
        'NPM_REGISTRY_INTEGRITY_RECORDED',
        'TRUSTED_GIT_NO_RELEASE_SIGNATURE',
        'TRUST_OVERRIDE_UNVERIFIED'
    ].every((marker) => branchProtection.includes(marker));

    const checks = [
        { passed: npmAuditBlocking, detail: 'blocking: security.yml npm audit high-severity gate present' },
        { passed: osvInformational, detail: 'informational: security.yml OSV lockfile scan present' },
        { passed: gitleaksBlocking, detail: 'blocking: secret-scanning.yml gitleaks gate present' },
        { passed: sbomInformational, detail: 'informational: sbom.yml CycloneDX artifact generation present' },
        { passed: requiredCheckGuidance, detail: 'informational: branch protection required-check guidance labels retained security checks' },
        { passed: actionPinningDecision, detail: 'informational: GitHub Action pinning decision documented' },
        { passed: updateSourcePolicyReporting, detail: 'informational: update-source policy reporting statuses documented' }
    ];

    return {
        passed: checks.every((check) => check.passed),
        details: checks.map((check) => `${check.detail}=${check.passed}`)
    };
}

function validateTrustedPublishWorkflowContract(repoRoot: string): { passed: boolean; details: string[] } {
    const rawPublishWorkflow = readTextFileIfExists(path.join(repoRoot, '.github', 'workflows', 'publish.yml')) || '';
    const publishWorkflow = readWorkflowForReadiness(repoRoot, 'publish.yml');
    const publishWorkflowExactlyReviewed = workflowStructuralBlockContractSha256(rawPublishWorkflow)
        === TRUSTED_RELEASE_WORKFLOW_SHA256;
    const validateJob = getWorkflowJobBlockUnderJobs(publishWorkflow, 'validate');
    const publishJob = getWorkflowJobBlockUnderJobs(publishWorkflow, 'publish');
    const onBlock = getYamlKeyBlock(publishWorkflow, 'on');
    const pushTriggerBlock = getYamlDirectChildBlock(onBlock, 'push');
    const workflowEnv = getYamlKeyBlock(publishWorkflow, 'env');
    const workflowPermissions = getYamlKeyBlock(publishWorkflow, 'permissions');
    const tagTriggers = extractYamlListAfterKey(pushTriggerBlock, 'tags');
    const validateCheckout = getWorkflowUseStepBlock(validateJob || '', 'actions/checkout@v7.0.0');
    const publishCheckout = getWorkflowUseStepBlock(publishJob || '', 'actions/checkout@v7.0.0');
    const validateSetupNode = getWorkflowUseStepBlock(validateJob || '', 'actions/setup-node@v6');
    const publishSetupNode = getWorkflowUseStepBlock(publishJob || '', 'actions/setup-node@v6');
    const validateCheckoutWith = getYamlKeyBlock(validateCheckout, 'with');
    const publishCheckoutWith = getYamlKeyBlock(publishCheckout, 'with');
    const validateSetupWith = getYamlKeyBlock(validateSetupNode, 'with');
    const publishSetupWith = getYamlKeyBlock(publishSetupNode, 'with');
    const publishPermissions = getYamlKeyBlock(publishJob, 'permissions');
    const validateUploadArtifact = getWorkflowUseStepBlock(validateJob || '', 'actions/upload-artifact@v7.0.1');
    const validateUploadWith = getYamlKeyBlock(validateUploadArtifact, 'with');
    const validateRunScripts = validateJob === null ? [] : extractWorkflowRunScripts(validateJob);
    const publishRunScripts = publishJob === null ? [] : extractWorkflowRunScripts(publishJob);

    const tagVersionGuard = workflowRunScriptsIncludeAll(validateRunScripts, [
        'set -euo pipefail',
        'GITHUB_REF_TYPE',
        'GITHUB_REF_NAME',
        'TAG_VERSION="${GITHUB_REF_NAME#v}"',
        `PACKAGE_VERSION="$(node -p "require('./package.json').version")"`,
        `LOCK_VERSION="$(node -p "require('./package-lock.json').version")"`,
        `LOCK_ROOT_VERSION="$(node -p "require('./package-lock.json').packages[''].version")"`,
        `VERSION_FILE="$(node -e "process.stdout.write(require('node:fs').readFileSync('VERSION', 'utf8').trim())")"`,
        '${TAG_VERSION}" != "${PACKAGE_VERSION}',
        '${TAG_VERSION}" != "${LOCK_VERSION}',
        '${TAG_VERSION}" != "${LOCK_ROOT_VERSION}',
        '${TAG_VERSION}" != "${VERSION_FILE}',
        'exit 1'
    ]);
    const publishSanityGuard = workflowRunScriptsIncludeAll(publishRunScripts, [
        'set -euo pipefail',
        'GITHUB_REF_TYPE',
        'GITHUB_REF_NAME',
        'TAG_VERSION="${GITHUB_REF_NAME#v}"',
        `PACKAGE_NAME="$(node -p "require('./package.json').name")"`,
        `PACKAGE_VERSION="$(node -p "require('./package.json').version")"`,
        `LOCK_VERSION="$(node -p "require('./package-lock.json').version")"`,
        `LOCK_ROOT_VERSION="$(node -p "require('./package-lock.json').packages[''].version")"`,
        `VERSION_FILE="$(node -e "process.stdout.write(require('node:fs').readFileSync('VERSION', 'utf8').trim())")"`,
        '${PACKAGE_NAME}" != "garda-agent-orchestrator"',
        '${TAG_VERSION}" != "${PACKAGE_VERSION}',
        '${TAG_VERSION}" != "${LOCK_VERSION}',
        '${TAG_VERSION}" != "${LOCK_ROOT_VERSION}',
        '${TAG_VERSION}" != "${VERSION_FILE}',
        'NPM_VERSION="$(npm --version)"',
        'test "${NPM_VERSION}" = "11.15.0"'
    ]);
    const validateDropsEphemeralTagRef = workflowRunScriptsIncludeAll(validateRunScripts, [
        'git update-ref -d "refs/tags/${GITHUB_REF_NAME}"'
    ]);
    const publishDropsEphemeralTagRef = workflowRunScriptsIncludeAll(publishRunScripts, [
        'git update-ref -d "refs/tags/${GITHUB_REF_NAME}"'
    ]);
    const validateRejectsWorkflowReruns = workflowRunScriptsIncludeAll(validateRunScripts, [
        'github.run_attempt',
        '!= "1"',
        'exit 1'
    ]);
    const publishRejectsWorkflowReruns = workflowRunScriptsIncludeAll(publishRunScripts, [
        'github.run_attempt',
        '!= "1"',
        'exit 1'
    ]);
    const actionsHistoryReadable = blockHasNonCommentLine(workflowPermissions, 'actions: read');
    const historicalTagReuseStep = getWorkflowNamedStepBlock(
        validateJob || '',
        'Reject previously used release tags'
    );
    const validateRejectsHistoricalTagReuse = workflowBlockContractSha256(historicalTagReuseStep)
        === TRUSTED_RELEASE_TAG_HISTORY_STEP_SHA256;
    const fullTagHistoryAvailable = blockHasNonCommentLine(validateCheckoutWith, 'fetch-depth: 0')
        && blockHasNonCommentLine(publishCheckoutWith, 'fetch-depth: 0');
    const tagDrivenOnly = tagTriggers.includes('v*') && !publishWorkflow.includes('workflow_dispatch:');
    const nodeVersionPinned = yamlBlockHasScalarValue(workflowEnv, 'NODE_VERSION', ['24', '24.x']);
    const ciProofStep = getWorkflowNamedStepBlock(validateJob || '', 'Require successful CI for this release commit');
    const candidatePackStep = getWorkflowNamedStepBlock(validateJob || '', 'Pack and attest release candidate');
    const ciCommitBound = workflowStructuralBlockContractSha256(ciProofStep) === TRUSTED_RELEASE_CI_PROOF_STEP_SHA256
        && workflowRunScriptsIncludeExecutableMarkers(validateRunScripts, [
        'test "$(git rev-parse HEAD)" = "${GITHUB_SHA}"',
        'actions/workflows/ci.yml/runs',
        'release-candidate.cjs verify-ci'
    ]);
    const releaseNpmPinned = workflowJobHasRunStep(validateJob || '', 'npm install -g npm@11.15.0')
        && workflowJobHasRunStep(publishJob || '', 'npm install -g npm@11.15.0')
        && workflowRunScriptsIncludeExecutableMarkers(validateRunScripts, ['test "$(npm --version)" = "11.15.0"'])
        && workflowRunScriptsIncludeExecutableMarkers(publishRunScripts, ['test "$(npm --version)" = "11.15.0"']);
    const candidatePackAndUpload = workflowStructuralBlockContractSha256(candidatePackStep)
        === TRUSTED_RELEASE_CANDIDATE_PACK_STEP_SHA256
        && workflowRunScriptsIncludeExecutableMarkersInOrder(validateRunScripts, [
        'set -euo pipefail',
        'CANDIDATE_DIR="${RUNNER_TEMP}/release-candidate"',
        'npm pack --json --pack-destination "${CANDIDATE_DIR}"',
        'release-candidate.cjs create',
        'GARDA_RELEASE_CANDIDATE_PATH="${CANDIDATE_DIR}/${TARBALL_NAME}" npm run test:packaging',
        'release-candidate.cjs verify'
    ]) && workflowRunScriptsIncludeExecutableMarkers(validateRunScripts, ['${GITHUB_OUTPUT}']) && blockHasNonCommentLine(validateUploadWith, 'name: release-candidate-${{ github.sha }}')
        && blockHasNonCommentLine(validateUploadWith, 'path: ${{ runner.temp }}/release-candidate/')
        && blockHasNonCommentLine(validateUploadWith, 'if-no-files-found: error')
        && blockHasNonCommentLine(validateJob, 'tarball_sha256: ${{ steps.pack.outputs.tarball_sha256 }}')
        && blockHasNonCommentLine(validateJob, 'tarball_name: ${{ steps.pack.outputs.tarball_name }}');
    const candidatePublishStepNames = [
        'Download validated release candidate',
        'Verify downloaded candidate',
        'Stage the validated tarball with npm Trusted Publishing'
    ];
    const candidatePublishSteps = candidatePublishStepNames
        .map((name) => getWorkflowNamedStepBlock(publishJob || '', name));
    const candidateStepPositions = candidatePublishSteps
        .map((block) => block === null ? -1 : (publishJob || '').indexOf(block));
    const candidateStepsAdjacent = candidatePublishSteps.every((block) => block !== null)
        && candidateStepPositions.every((position) => position >= 0)
        && candidateStepPositions.slice(0, -1).every((position, index) =>
            (publishJob || '').slice(position + candidatePublishSteps[index]!.length, candidateStepPositions[index + 1]).trim() === '')
        && (publishJob || '').slice(
            candidateStepPositions[2] + candidatePublishSteps[2]!.length
        ).trim() === '';
    const candidatePublishStepsHash = workflowBlockContractSha256(candidatePublishSteps.every((block) => block !== null)
        ? candidatePublishSteps.join('\n') : null);
    const publishUsesValidatedCandidate = blockHasNonCommentLine(publishPermissions, 'actions: read')
        && candidateStepsAdjacent
        && candidatePublishStepsHash === TRUSTED_RELEASE_CANDIDATE_PUBLISH_STEPS_SHA256
        && workflowStructuralBlockContractSha256(publishJob) === TRUSTED_RELEASE_PUBLISH_JOB_SHA256
        && !workflowJobHasRunStep(publishJob, 'npm run release:preflight');
    const validateJobContract = validateJob !== null
        && blockHasNonCommentLine(validateJob, 'runs-on: ubuntu-latest')
        && workflowHasUseStep(validateJob, 'actions/checkout@v7.0.0')
        && fullTagHistoryAvailable
        && validateSetupNode !== null
        && nodeVersionPinned
        && blockHasNonCommentLine(validateSetupWith, "node-version: ${{ env.NODE_VERSION }}")
        && blockHasNonCommentLine(validateSetupWith, 'package-manager-cache: false')
        && validateRejectsWorkflowReruns
        && actionsHistoryReadable
        && validateRejectsHistoricalTagReuse
        && tagVersionGuard
        && validateDropsEphemeralTagRef
        && workflowJobHasRunStep(validateJob, 'npm ci --no-fund --no-audit')
        && workflowJobHasRunStep(validateJob, 'npm run release:preflight')
        && ciCommitBound
        && releaseNpmPinned
        && candidatePackAndUpload
        && validateUploadArtifact !== null;
    const publishJobContract = publishJob !== null
        && blockHasNonCommentLine(publishJob, 'runs-on: ubuntu-latest')
        && blockHasNonCommentLine(publishJob, 'needs: validate')
        && blockHasNonCommentLine(publishJob, 'environment: npm-release')
        && blockHasNonCommentLine(publishPermissions, 'contents: read')
        && blockHasNonCommentLine(publishPermissions, 'id-token: write')
        && workflowHasUseStep(publishJob, 'actions/checkout@v7.0.0')
        && fullTagHistoryAvailable
        && publishSetupNode !== null
        && nodeVersionPinned
        && blockHasNonCommentLine(publishSetupWith, "node-version: ${{ env.NODE_VERSION }}")
        && blockHasNonCommentLine(publishSetupWith, 'registry-url: https://registry.npmjs.org')
        && blockHasNonCommentLine(publishSetupWith, 'package-manager-cache: false')
        && releaseNpmPinned
        && publishRejectsWorkflowReruns
        && publishSanityGuard
        && publishDropsEphemeralTagRef
        && publishUsesValidatedCandidate
        && !workflowJobHasExactRunLine(publishJob, 'npm publish');
    const tokenlessOidc = !publishWorkflow.includes('NODE_AUTH_TOKEN')
        && !publishWorkflow.includes('NPM_TOKEN')
        && !publishWorkflow.includes('--provenance')
        && !publishWorkflow.includes('self-hosted');

    const checks = [
        { passed: publishWorkflow !== '', detail: 'publish.yml present' },
        { passed: publishWorkflowExactlyReviewed, detail: 'publish workflow exactly matches the reviewed release path' },
        { passed: tagDrivenOnly, detail: 'publish.yml is v*-tag driven without manual dispatch' },
        { passed: nodeVersionPinned, detail: 'publish workflow pins Node 24 for Trusted Publishing' },
        { passed: actionsHistoryReadable, detail: 'publish workflow has read-only access to provider workflow-run history' },
        { passed: fullTagHistoryAvailable, detail: 'publish jobs fetch release-tag history for changelog preservation checks' },
        { passed: tagVersionGuard, detail: 'validate job has fail-closed tag/version guard' },
        { passed: validateRejectsWorkflowReruns, detail: 'validate job rejects repeated workflow attempts' },
        { passed: validateRejectsHistoricalTagReuse, detail: 'validate job rejects release tags with a prior workflow run' },
        { passed: validateDropsEphemeralTagRef, detail: 'validate job removes its ephemeral local tag ref before release uniqueness proof' },
        { passed: ciCommitBound, detail: 'validate job requires successful CI for the exact release commit' },
        { passed: releaseNpmPinned, detail: 'release jobs pin npm CLI 11.15.0' },
        { passed: candidatePackAndUpload, detail: 'validate job packs, smokes, and uploads the digest-bound release candidate' },
        { passed: validateJobContract, detail: 'validate job checks tag/version, CI, release proof, and candidate tarball' },
        { passed: publishSanityGuard, detail: 'publish job has fail-closed package and npm CLI sanity guard' },
        { passed: publishRejectsWorkflowReruns, detail: 'publish job rejects repeated workflow attempts' },
        { passed: publishDropsEphemeralTagRef, detail: 'publish job removes its ephemeral local tag ref before release uniqueness proof' },
        { passed: publishUsesValidatedCandidate, detail: 'publish job verifies and stages the exact validated tarball without rebuilding' },
        { passed: publishJobContract, detail: 'publish job is npm-release environment bound and uses id-token OIDC staged publishing' },
        { passed: tokenlessOidc, detail: 'publish workflow avoids npm tokens, --provenance override, and self-hosted runners' }
    ];

    return {
        passed: checks.every((check) => check.passed),
        details: checks.map((check) => `${check.detail}=${check.passed}`)
    };
}

function validateTrustedPublishDocsContract(repoRoot: string, version: string | null): { passed: boolean; details: string[] } {
    const releaseReadiness = readTextFileIfExists(path.join(repoRoot, 'docs', 'release-readiness.md')) || '';
    const runMethods = readTextFileIfExists(path.join(repoRoot, 'docs', 'run-methods.md')) || '';
    const platformDocs = readTextFileIfExists(path.join(repoRoot, 'docs', 'node-platform-foundation.md')) || '';
    const targetVersion = version || 'unknown';
    const versionCommand = `npx --yes garda-agent-orchestrator@${targetVersion} --version`;

    const checklistDocumentsTrustedPublishing = [
        `## ${targetVersion}`,
        'Trusted Publishing',
        '`publish.yml`',
        '`npm-release`',
        'release-tag restricted',
        '`Shubchynskyi`',
        '`garda-agent-orchestrator`',
        '`npm stage publish`',
        'npm-side staged approval',
        'Require two-factor authentication and disallow tokens',
        versionCommand
    ].every((marker) => releaseReadiness.includes(marker));
    const runbookDocumentsOperatorSetup = [
        '.github/workflows/publish.yml',
        'npm-release',
        'selected deployment branches/tags',
        'v*',
        'Trusted Publisher',
        'Shubchynskyi',
        'publish.yml',
        'npm staged publishing approval',
        'Require two-factor authentication and disallow tokens',
        'npm stage publish'
    ].every((marker) => runMethods.includes(marker));
    const platformDocsNameTagDrivenRelease = [
        'Tag-driven npm staged publishing',
        '.github/workflows/publish.yml',
        'npm Trusted Publishing',
        'npm staged approval',
        'v*',
        'OIDC',
        'npm stage publish'
    ].every((marker) => platformDocs.includes(marker));

    const checks = [
        { passed: checklistDocumentsTrustedPublishing, detail: `docs/release-readiness.md records ${targetVersion} Trusted Publishing readiness` },
        { passed: runbookDocumentsOperatorSetup, detail: 'docs/run-methods.md documents GitHub Environment and npm Trusted Publisher setup' },
        { passed: platformDocsNameTagDrivenRelease, detail: 'docs/node-platform-foundation.md names the tag-driven OIDC release path' }
    ];

    return {
        passed: checks.every((check) => check.passed),
        details: checks.map((check) => `${check.detail}=${check.passed}`)
    };
}

function canPublishForbiddenPackageRoot(entry: string): boolean {
    const normalizedEntry = entry
        .trim()
        .replace(/\\/g, '/')
        .replace(/^(?:\.\/)+/, '')
        .replace(/^\/+/, '')
        .replace(/\/+$/, '');

    if (!normalizedEntry || normalizedEntry.startsWith('!')) {
        return false;
    }

    return (
        /[*?\[\]{}()]/.test(normalizedEntry) ||
        FORBIDDEN_PUBLISHED_PACKAGE_SURFACE_ITEMS.some(
            (forbiddenRoot) => normalizedEntry === forbiddenRoot || normalizedEntry.startsWith(`${forbiddenRoot}/`)
        )
    );
}

function validateReleaseReadinessContracts(repoRoot: string): ReleaseReadinessResult {
    const normalizedRoot = path.resolve(repoRoot);
    const violations: string[] = [];
    const checks: ReleaseReadinessCheck[] = [];
    const packageJson = readPackageJsonObject(normalizedRoot, violations);
    const scripts = getStringRecord(packageJson?.scripts);
    const packageFiles = getStringArray(packageJson?.files);
    const version = typeof packageJson?.version === 'string' ? packageJson.version : null;

    const validateRelease = scripts['validate:release'] || '';
    const validateReadiness = scripts['validate:release-readiness'] || '';
    const validatePackageSurface = scripts['validate:package-surface'] || '';
    const releaseSmoke = scripts['test:release-smoke'] || '';
    const releasePreflight = scripts['release:preflight'] || '';
    const archiveSource = scripts['archive:source'] || '';
    const archiveEvidence = scripts['archive:evidence'] || '';
    const quality = scripts.quality || '';
    const qualityFast = scripts['quality:fast'] || '';
    const prepack = scripts.prepack || '';
    const manifestText = readTextFileIfExists(path.join(normalizedRoot, 'MANIFEST.md')) || '';
    const validateReleaseFast = scripts['validate:release:fast'] || '';
    const packageSurfaceTests = scripts['test:packaging'] || '';
    const baselinePath = path.join(normalizedRoot, PACKAGE_SURFACE_BASELINE_PATH);
    let baselineValid = false;
    let baselineIdentityAligned = false;
    let baselineDetail = `missing ${PACKAGE_SURFACE_BASELINE_PATH}`;
    const baselineText = readTextFileIfExists(baselinePath);
    if (baselineText !== null) {
        try {
            const baseline = parsePackageSurfaceBaseline(JSON.parse(baselineText), baselinePath);
            baselineValid = true;
            baselineIdentityAligned = baseline.package.name === packageJson?.name
                && baseline.package.version === version;
            baselineDetail = `${baseline.package.name}@${baseline.package.version}: ${baseline.rationale}`;
        } catch (error: unknown) {
            baselineDetail = error instanceof Error ? error.message : String(error);
        }
    }

    pushCheck(
        checks,
        violations,
        'package',
        'validate:release composes clean worktree, version parity, build, embedded parity, quality, pack smoke, and final clean worktree',
        Boolean(validateRelease) &&
            validateRelease.includes('npm run validate:version-parity') &&
            validateRelease.includes('npm run build') &&
            validateRelease.includes('npm run validate:embedded-bundle-parity') &&
            validateRelease.includes('npm run quality') &&
            validateRelease.includes('npm run test:packaging') &&
            countOccurrences(validateRelease, 'npm run validate:clean-worktree') >= 2,
        [validateRelease || 'missing validate:release']
    );

    pushCheck(
        checks,
        violations,
        'package-surface',
        'release preflight scores the deterministic packed surface against a tracked explicit baseline',
        validatePackageSurface === 'node scripts/node-foundation/build-scripts.cjs validate-release.js package-surface' &&
            releasePreflight.endsWith('&& npm run validate:package-surface') &&
            packageSurfaceTests.includes('tests/node/packaging/package-surface.test.ts') &&
            baselineValid &&
            baselineIdentityAligned &&
            isGitTracked(normalizedRoot, PACKAGE_SURFACE_BASELINE_PATH),
        [
            `validate:package-surface=${validatePackageSurface || 'missing'}`,
            `test:packaging=${packageSurfaceTests || 'missing'}`,
            `baseline=${baselineDetail}`,
            `baselineIdentityAligned=${baselineIdentityAligned}`,
            `baselineTracked=${isGitTracked(normalizedRoot, PACKAGE_SURFACE_BASELINE_PATH)}`
        ]
    );

    const releaseTagAssignment = validateReleaseTagAssignment(normalizedRoot, version);
    pushCheck(
        checks,
        violations,
        'release-tag',
        'the target version is not assigned to another local Git commit',
        releaseTagAssignment.passed,
        releaseTagAssignment.details
    );

    const changelogReleaseSection = validateChangelogReleaseSection(normalizedRoot, version);
    pushCheck(
        checks,
        violations,
        'changelog',
        'CHANGELOG starts with one populated target section and preserves released history',
        changelogReleaseSection.passed,
        changelogReleaseSection.details
    );

    const markdownLinks = validateTrackedMarkdownLinks(normalizedRoot);
    pushCheck(
        checks,
        violations,
        'documentation-links',
        'tracked Markdown documents contain no broken repository-relative links',
        markdownLinks.passed,
        markdownLinks.details
    );

    pushCheck(
        checks,
        violations,
        'package-fast',
        'validate:release:fast composes clean worktree, version parity, build, embedded parity, fast quality, pack smoke, and final clean worktree',
        Boolean(validateReleaseFast) &&
            validateReleaseFast.includes('npm run validate:version-parity') &&
            validateReleaseFast.includes('npm run build') &&
            validateReleaseFast.includes('npm run validate:embedded-bundle-parity') &&
            validateReleaseFast.includes('npm run quality:fast') &&
            validateReleaseFast.includes('npm run test:packaging') &&
            countOccurrences(validateReleaseFast, 'npm run validate:clean-worktree') >= 2,
        [validateReleaseFast || 'missing validate:release:fast']
    );

    pushCheck(
        checks,
        violations,
        'release-gate',
        'release:preflight runs release readiness and short release smoke before release validation and package-surface scoring',
        validateReadiness === 'node scripts/node-foundation/build-scripts.cjs validate-release.js release-readiness' &&
            releaseSmoke.includes('tests/node/core/task-ids.test.ts') &&
            releaseSmoke.includes('tests/node/gate-runtime/task-events-append.test.ts') &&
            releaseSmoke.includes('tests/node/gates/next-step/next-step-startup-routing.test.ts') &&
            releaseSmoke.includes('tests/node/validators/status.test.ts') &&
            releaseSmoke.includes('tests/node/validators/why-blocked.test.ts') &&
            releaseSmoke.includes('tests/node/validators/doctor-formatting.test.ts') &&
            !releaseSmoke.includes('tests/node/packaging/pack-smoke.test.ts') &&
            validateRelease.includes('npm run test:packaging') &&
            releasePreflight === 'npm run validate:release-readiness && npm run test:release-smoke && npm run validate:release && npm run validate:package-surface',
        [
            `validate:release-readiness=${validateReadiness || 'missing'}`,
            `test:release-smoke=${releaseSmoke || 'missing'}`,
            `validate:release=${validateRelease || 'missing'}`,
            `release:preflight=${releasePreflight || 'missing'}`
        ]
    );

    pushCheck(
        checks,
        violations,
        'release-archives',
        'release handoff exposes separate source and evidence archive commands',
        archiveSource === 'node scripts/node-foundation/build-scripts.cjs archive-release.js source' &&
            archiveEvidence === 'node scripts/node-foundation/build-scripts.cjs archive-release.js evidence',
        [
            `archive:source=${archiveSource || 'missing'}`,
            `archive:evidence=${archiveEvidence || 'missing'}`
        ]
    );

    pushCheck(
        checks,
        violations,
        'security',
        'quality keeps unused-symbol enforcement, production audit, and security document surface aligned',
        quality.includes('npm run typecheck:unused') &&
            qualityFast.includes('npm run typecheck:unused') &&
            scripts['typecheck:unused'] === 'tsc -p tsconfig.node-foundation.json --noEmit --pretty false --noUnusedLocals --noUnusedParameters' &&
            quality.includes('npm run audit:prod') &&
            scripts['audit:prod'] === 'npm audit --omit=dev' &&
            SECURITY_RELEASE_DOC_ITEMS.every((entry) => fileExists(normalizedRoot, entry)) &&
            SECURITY_RELEASE_DOC_ITEMS.every((entry) => packageFiles.includes(entry)) &&
            manifestListsEvery(manifestText, SECURITY_RELEASE_DOC_ITEMS),
        [
            quality || 'missing quality',
            `quality:fast=${qualityFast || 'missing'}`,
            `typecheck:unused=${scripts['typecheck:unused'] || 'missing'}`,
            `audit:prod=${scripts['audit:prod'] || 'missing'}`,
            `security_docs=${SECURITY_RELEASE_DOC_ITEMS.join(', ')}`
        ]
    );

    pushCheck(
        checks,
        violations,
        'packaging',
        'prepack and package files preserve clean-package, compiled-only runtime, and linked public-doc contracts',
        prepack.includes('npm run validate:clean-worktree') &&
            prepack.includes('npm run build:publish-runtime') &&
            prepack.includes('node scripts/package-legacy-entrypoint-compat.cjs create') &&
            PUBLISHED_PACKAGE_SURFACE_ITEMS
                .concat(SECURITY_RELEASE_DOC_ITEMS)
                .concat(PUBLIC_PACKAGE_DOC_ITEMS)
                .every((entry) => packageFiles.includes(entry)) &&
            packageFiles.every((entry) => !canPublishForbiddenPackageRoot(entry)) &&
            PUBLIC_PACKAGE_DOC_ITEMS.every((entry) => fileExists(normalizedRoot, entry)) &&
            manifestListsEvery(manifestText, PUBLIC_PACKAGE_DOC_ITEMS),
        [prepack || 'missing prepack', `files=${packageFiles.join(', ') || 'missing'}`]
    );

    const requiredTestShardScripts = Object.freeze([
        'test:unit',
        'test:gates',
        'test:cli',
        'test:lifecycle',
        'test:bin',
        'test:packaging',
        'test:sharded',
        'test:full'
    ]);
    const missingShardScripts = requiredTestShardScripts.filter((name) => !scripts[name]);
    pushCheck(
        checks,
        violations,
        'test-shards',
        'focused test shard scripts are present in package.json for targeted validation',
        missingShardScripts.length === 0,
        missingShardScripts.length === 0
            ? requiredTestShardScripts.map((name) => `${name}: present`)
            : missingShardScripts.map((name) => `missing: ${name}`)
    );

    const ciWorkflow = readTextFileIfExists(path.join(normalizedRoot, '.github', 'workflows', 'ci.yml')) || '';
    const ciRuntimeMatrix = validateCiRuntimeMatrixContract(ciWorkflow);
    pushCheck(
        checks,
        violations,
        'ci',
        'CI keeps release validation on Linux and Windows, Node 22.13+ and Node 24 matrices, and lifecycle update smoke on all supported OS families',
        ciRuntimeMatrix.passed,
        ciRuntimeMatrix.details
    );

    const securityCiBaseline = validateSecurityCiBaselineContract(normalizedRoot);
    pushCheck(
        checks,
        violations,
        'security-ci',
        'existing release-security CI checks are present and labelled blocking or informational',
        securityCiBaseline.passed,
        securityCiBaseline.details
    );

    const trustedPublishWorkflow = validateTrustedPublishWorkflowContract(normalizedRoot);
    pushCheck(
        checks,
        violations,
        'trusted-publish-workflow',
        'npm Trusted Publishing workflow is tag-driven, stage-only, tokenless, and provenance-ready',
        trustedPublishWorkflow.passed,
        trustedPublishWorkflow.details
    );

    const trustedPublishDocs = validateTrustedPublishDocsContract(normalizedRoot, version);
    pushCheck(
        checks,
        violations,
        'trusted-publish-docs',
        'release docs document the tag-driven npm Trusted Publishing operator path',
        trustedPublishDocs.passed,
        trustedPublishDocs.details
    );

    const cliReference = readTextFileIfExists(path.join(normalizedRoot, 'docs', 'cli-reference.md')) || '';
    const runMethods = readTextFileIfExists(path.join(normalizedRoot, 'docs', 'run-methods.md')) || '';
    const platformDocs = readTextFileIfExists(path.join(normalizedRoot, 'docs', 'node-platform-foundation.md')) || '';
    pushCheck(
        checks,
        violations,
        'runtime-state',
        'operator docs keep doctor, manifest validation, task-event timelines, derived-index recovery, and full-suite optimization guardrails visible',
        cliReference.includes('garda doctor') &&
            cliReference.includes('garda gate validate-manifest') &&
            cliReference.includes('runtime/task-events/<task-id>.jsonl') &&
            runMethods.includes('gate validate-manifest') &&
            platformDocs.includes('cross-platform lifecycle smoke') &&
            platformDocs.includes('Full-suite optimization compatibility guardrails') &&
            platformDocs.includes('GARDA_NODE_FOUNDATION_TEST_SHARDS'),
        ['docs/cli-reference.md, docs/run-methods.md, docs/node-platform-foundation.md']
    );

    const releaseChecklist = validateReleaseChecklist(normalizedRoot, version);
    const releaseChecklistVersion = version || 'unknown';
    pushCheck(
        checks,
        violations,
        'release-blockers',
        `tracked Release ${releaseChecklistVersion} readiness checklist is complete`,
        releaseChecklist.releaseChecklistItems.length > 0 &&
            releaseChecklist.openReleaseChecklistItems.length === 0,
        releaseChecklist.details
    );

    const releaseNotesInput = [
        `Version: ${version || 'unknown'}`,
        'Validation command: npm run release:preflight',
        'Package proof: validate:release covers clean worktree, version parity, build, embedded bundle parity, quality, pack smoke, and final clean worktree.',
        `Readiness alignment: validate:release-readiness checks package, CI runtime matrix, runtime-state docs, security-document surface, npm Trusted Publishing workflow/docs, and the tracked Release ${releaseChecklistVersion} checklist before the full proof path.`,
        'Short smoke: test:release-smoke exercises task id parsing, task-event append integrity, next-step startup routing, and status and doctor formatting before the full proof path.',
        'Package smoke: npm run test:packaging remains an explicit validate:release step for pack, install, and CLI invoke proof.',
        'Update/runtime alignment: CI workflow is configured for setup, update git, doctor, and uninstall smoke across Linux, Windows, and macOS.',
        'Unused-symbol enforcement: quality includes typecheck:unused with --noUnusedLocals and --noUnusedParameters before lint, coverage, and production npm audit.',
        'Security/audit alignment: quality includes production npm audit and security/SBOM/threat-model docs are present in source, package files, and MANIFEST.',
        'Release-security baseline: readiness labels npm audit and gitleaks as blocking, OSV and SBOM as informational, and reports action-pinning plus update-source provenance policy without adding a duplicate security pipeline.',
        'Trusted Publishing path: pushing the matching v* tag runs .github/workflows/publish.yml, validates the package before staging, then uses npm-release OIDC trusted publishing for tokenless npm stage publish; npm-side staged approval with 2FA makes the package public.',
        `Post-publish verification: confirm npm latest, package integrity/provenance visibility, and npx --yes garda-agent-orchestrator@${version || '<version>'} --version.`
    ];

    return {
        repoRoot: normalizedRoot,
        version,
        passed: violations.length === 0,
        violations,
        checks,
        releaseChecklistItems: releaseChecklist.releaseChecklistItems,
        openReleaseChecklistItems: releaseChecklist.openReleaseChecklistItems,
        releaseNotesInput
    };
}

export function validateReleaseReadiness(
    repoRoot: string, request?: CandidateReadinessRequest, dependencies?: CandidateReadinessDependencies
): ReleaseReadinessResult {
    const result = validateReleaseReadinessContracts(repoRoot);
    if (!request) return result;
    const candidate = validateCandidateReadiness(path.resolve(repoRoot), request, dependencies);
    if (!result.passed) candidate.decision = 'NO_GO';
    return { ...result, candidate, passed: result.passed && candidate.decision === 'GO',
        checks: [...result.checks, ...candidate.checks], violations: [...result.violations, ...candidate.violations] };
}

export function formatReleaseReadinessResult(result: ReleaseReadinessResult): string {
    const lines: string[] = [];

    lines.push(result.passed ? 'RELEASE_READINESS_OK' : 'RELEASE_READINESS_FAILED');
    lines.push(`ReleaseDecision: ${result.candidate?.decision || 'NOT_EVALUATED (static preflight only)'}`);
    if (result.candidate) lines.push(`TaskQueueSha256: ${result.candidate.taskQueueSha256 || 'unavailable'}`);
    lines.push(`RepoRoot: ${result.repoRoot}`);
    lines.push(`Version: ${result.version || 'unknown'}`);
    lines.push(`ReleaseChecklistItems: ${result.releaseChecklistItems.length}`);
    lines.push(`OpenReleaseChecklistItems: ${result.openReleaseChecklistItems.length === 0 ? 'none' : result.openReleaseChecklistItems.join('; ')}`);
    lines.push('Checklist:');
    for (const check of result.checks) {
        lines.push(`  [${check.passed ? 'x' : ' '}] ${check.area}: ${check.label}`);
        if (!check.passed) {
            for (const detail of check.details) {
                lines.push(`      - ${detail}`);
            }
        }
    }

    if (!result.passed) {
        lines.push('Violations:');
        for (const violation of result.violations) {
            lines.push(`- ${violation}`);
        }
    }

    lines.push('ReleaseNotesInput:');
    for (const entry of result.releaseNotesInput) {
        lines.push(`- ${entry}`);
    }

    return lines.join('\n');
}

export function runReleaseReadinessValidation(request?: CandidateReadinessRequest): ReleaseReadinessResult {
    const result = validateReleaseReadiness(getRepoRoot(), request);
    console.log(formatReleaseReadinessResult(result));
    if (!result.passed) {
        process.exit(1);
    }
    return result;
}
