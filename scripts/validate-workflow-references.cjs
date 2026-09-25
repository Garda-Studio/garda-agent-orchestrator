#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Verify upstream release commits before changing these pins and the workflow comments together.
const VERIFIED_PINS = new Map([
    ['actions/checkout', {
        sha: '9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0', version: 'v7.0.0',
        release: 'https://github.com/actions/checkout/releases/tag/v7.0.0'
    }],
    ['actions/setup-node', {
        sha: '249970729cb0ef3589644e2896645e5dc5ba9c38', version: 'v6.5.0',
        release: 'https://github.com/actions/setup-node/releases/tag/v6.5.0'
    }],
    ['actions/upload-artifact', {
        sha: '043fb46d1a93c77aae656e7c1c64a875d1fc6a0a', version: 'v7.0.1',
        release: 'https://github.com/actions/upload-artifact/releases/tag/v7.0.1'
    }],
    ['google/osv-scanner-action/.github/workflows/osv-scanner-reusable.yml', {
        sha: 'b77c075a1235514558f0eb88dbd31e22c45e0cd2', version: 'v2.3.0',
        release: 'https://github.com/google/osv-scanner-action/releases/tag/v2.3.0'
    }]
]);

const USES_KEY = /^\s*(?:-\s*)?(?:uses|'uses'|"uses")\s*:\s*(.*)$/u;
const ANY_USES_KEY = /(?:^|[\s,{\[])(?:uses|'uses'|"uses")\s*:/u;
// An escaped YAML key can decode to "uses". Reject it instead of guessing how YAML decodes it.
const ESCAPED_QUOTED_KEY = /(?:^|[\s,{\[])"(?:\\.|[^"\\])*\\(?:.|$)(?:\\.|[^"\\])*"\s*:/u;
// A double-quoted key can join physical lines after a trailing backslash.
const CONTINUED_QUOTED_KEY = /(?:^|[,{\[])\s*(?:-\s*)?(?:[&!]\S+\s+)*"[^"\r\n]*\\\s*$/u;
// Explicit, alias, anchor, and tagged keys can also resolve to "uses" after YAML parsing.
const SPECIAL_MAPPING_KEY = /(?:^|[,{\[])\s*(?:-\s*)?(?:\?(?=\s|$)|[*!&][^\s:,}]+(?:\s+[^:,}]+)?\s*:)/u;
const BLOCK_SCALAR = /^\s*(?:-\s*)?(?:[^:#]+:\s*)?(?:[&!]\S+\s+)*[|>](?:[1-9][-+]?|[-+][1-9]?)?\s*$/u;

function startsFlowCollection(before) {
    const opener = /[\[{]/u.exec(before);
    if (!opener) {
        return false;
    }
    const leading = before.slice(0, opener.index)
        .replace(/(?:[&!]\S+\s+)+$/u, '');
    const prefix = leading.trimEnd();
    return !prefix || /^\s*-$/u.test(prefix) ||
        (prefix.endsWith(':') && leading.length > prefix.length);
}

function startsQuotedValue(before) {
    const prefix = before.trimEnd();
    return /^\s*-\s+$/u.test(before) ||
        (prefix.endsWith(':') && (before.length > prefix.length || startsFlowCollection(before))) ||
        /(?:^\s*-\s+|:\s+)(?:[&!]\S+\s+)+$/u.test(before) ||
        /:\s*[\[{]+\s*(?:[&!]\S+\s+)+$/u.test(before) ||
        /:\s*[\[{].*,\s*(?:[&!]\S+\s+)+$/u.test(before);
}

function startsYamlQuote(line, index) {
    const before = line.slice(0, index);
    return startsQuotedValue(before) || !before.trim() ||
        (startsFlowCollection(before) && /[,\[{]\s*$/u.test(before));
}

function uncomment(line, initialQuote = null) {
    let quote = initialQuote;
    for (let index = 0; index < line.length; index++) {
        const character = line[index];
        if (quote === '"' && character === '\\') {
            index++;
        } else if (quote === "'" && character === "'" && line[index + 1] === "'") {
            index++;
        } else if (character === quote) {
            quote = null;
        } else if (!quote && (character === '"' || character === "'") && startsYamlQuote(line, index)) {
            quote = character;
        } else if (!quote && character === '#' && (index === 0 || /\s/u.test(line[index - 1]))) {
            return { content: line.slice(0, index), comment: line.slice(index + 1).trim() };
        }
    }
    return { content: line, comment: '' };
}

function maskQuotedValues(content, initialQuote = null) {
    const masked = content.split('');
    let openQuote = initialQuote;
    let openStart = initialQuote ? 0 : -1;
    for (let index = 0; index < content.length; index++) {
        const character = content[index];
        if (!openQuote) {
            if ((character === '"' || character === "'") && startsYamlQuote(content, index)) {
                openQuote = character;
                openStart = index;
            }
            continue;
        }
        if (openQuote === '"' && character === '\\') {
            index++;
            continue;
        }
        if (openQuote === "'" && character === "'" && content[index + 1] === "'") {
            index++;
            continue;
        }
        if (character !== openQuote) {
            continue;
        }
        // Keep quoted mapping keys visible; a quoted scalar value is inert YAML text.
        if (initialQuote || !/^\s*:/u.test(content.slice(index + 1))) {
            masked.fill(' ', openStart, index + 1);
        }
        openQuote = null;
        openStart = -1;
        initialQuote = null;
    }
    if (openQuote) {
        masked.fill(' ', openStart);
    }
    return { content: masked.join(''), openQuote, openStart };
}

function parseReference(rawValue) {
    const value = rawValue.trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
        return value.slice(1, -1);
    }
    return value;
}

function validateReference(repoRoot, reference, versionComment) {
    if (reference.startsWith('./')) {
        const segments = reference.slice(2).split('/');
        if (segments.some((segment) => !segment || segment === '.' || segment === '..' || segment.includes('\\'))) {
            return `Invalid local path: ${reference}`;
        }
        const localPath = path.resolve(repoRoot, ...segments);
        const relativePath = path.relative(repoRoot, localPath);
        if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
            return `Invalid local path: ${reference}`;
        }
        if (!fs.existsSync(localPath)) {
            return `Local reference does not exist: ${reference}`;
        }
        const realRoot = fs.realpathSync(repoRoot);
        const realLocalPath = fs.realpathSync(localPath);
        const realRelativePath = path.relative(realRoot, realLocalPath);
        if (!realRelativePath || realRelativePath.startsWith('..') || path.isAbsolute(realRelativePath)) {
            return `Local reference resolves outside repository: ${reference}`;
        }
        const localStat = fs.statSync(realLocalPath);
        if (reference.startsWith('./.github/workflows/') && !localStat.isFile()) {
            return `Local reusable workflow is not a file: ${reference}`;
        }
        return null;
    }

    const atIndex = reference.lastIndexOf('@');
    const identity = reference.slice(0, atIndex);
    const sha = reference.slice(atIndex + 1);
    if (atIndex < 1 || !/^[0-9a-f]{40}$/u.test(sha)) {
        return `External reference must use a full lowercase commit SHA: ${reference}`;
    }
    const pin = VERIFIED_PINS.get(identity);
    if (!pin) {
        return `External reference has no reviewed identity: ${identity}`;
    }
    if (pin.sha !== sha || pin.version !== versionComment) {
        return `External reference differs from reviewed ${pin.version} pin: ${reference}`;
    }
    return null;
}

function scanWorkflowLines(workflow, visit) {
    let blockIndent = null;
    let quotedValue = null;
    const lines = workflow.replace(/^\uFEFF/u, '').split(/\r?\n/u);
    for (const [index, line] of lines.entries()) {
        const indent = /^ */u.exec(line)[0].length;
        if (blockIndent !== null) {
            if (!line.trim() || indent > blockIndent) {
                continue;
            }
            blockIndent = null;
        }
        const { content, comment } = uncomment(line, quotedValue);
        if (!content.trim()) {
            continue;
        }
        const { content: masked, openQuote, openStart } = maskQuotedValues(content, quotedValue);
        const incompleteKey = openQuote && !quotedValue &&
            !startsQuotedValue(content.slice(0, openStart));
        const match = quotedValue ? null : USES_KEY.exec(content);
        const unsupported = !match && (incompleteKey || ANY_USES_KEY.test(masked) ||
            ESCAPED_QUOTED_KEY.test(masked) || (!quotedValue && CONTINUED_QUOTED_KEY.test(content)) ||
            SPECIAL_MAPPING_KEY.test(masked));
        visit({ index, line, comment, match, unsupported });
        if (!match && !unsupported && BLOCK_SCALAR.test(masked)) {
            // In "- name: |", the scalar key begins after the sequence marker.
            // A sibling "uses" key at that column is outside the scalar body.
            const sequencePrefix = /^ *- +/u.exec(content);
            const standaloneSequenceScalar = /^\s*-\s+(?:[&!]\S+\s+)*[|>]/u.test(masked);
            blockIndent = standaloneSequenceScalar ? indent : sequencePrefix ? sequencePrefix[0].length : indent;
        }
        quotedValue = incompleteKey ? null : openQuote;
    }
}

function scanWorkflowUses(workflow) {
    const uses = [];
    scanWorkflowLines(workflow, ({ index, line, comment, match }) => {
        if (match) {
            uses.push({ lineIndex: index, line, reference: parseReference(match[1]), versionComment: comment });
        }
    });
    return uses;
}

function validateWorkflow(repoRoot, filePath) {
    const errors = [];
    let referenceCount = 0;
    scanWorkflowLines(fs.readFileSync(filePath, 'utf8'), ({ index, comment, match, unsupported }) => {
        if (match) {
            referenceCount++;
            const error = validateReference(repoRoot, parseReference(match[1]), comment);
            if (error) {
                errors.push(`${path.basename(filePath)}:${index + 1}: ${error}`);
            }
        } else if (unsupported) {
            errors.push(`${path.basename(filePath)}:${index + 1}: Unsupported uses syntax`);
        }
    });
    return { errors, referenceCount };
}

function main() {
    if (process.argv.length !== 2 &&
        (process.argv.length !== 4 || process.argv[2] !== '--repo-root')) {
        throw new Error('Usage: node scripts/validate-workflow-references.cjs [--repo-root <path>]');
    }
    const repoRoot = path.resolve(process.argv[3] || path.join(__dirname, '..'));
    const workflowDir = path.join(repoRoot, '.github', 'workflows');
    const relativeWorkflowDir = path.relative(fs.realpathSync(repoRoot), fs.realpathSync(workflowDir));
    if (!relativeWorkflowDir || relativeWorkflowDir.startsWith('..') || path.isAbsolute(relativeWorkflowDir)) {
        throw new Error(`Workflow directory resolves outside repository: ${workflowDir}`);
    }
    const entries = fs.readdirSync(workflowDir, { withFileTypes: true })
        .filter((entry) => /\.ya?ml$/u.test(entry.name));
    if (entries.length === 0) {
        throw new Error(`No workflow files found in ${workflowDir}`);
    }
    const errors = [];
    let referenceCount = 0;
    for (const entry of entries) {
        if (!entry.isFile()) {
            errors.push(`${entry.name}: Workflow must be a regular file`);
            continue;
        }
        const result = validateWorkflow(repoRoot, path.join(workflowDir, entry.name));
        errors.push(...result.errors);
        referenceCount += result.referenceCount;
    }
    if (errors.length) {
        for (const error of errors) {
            process.stderr.write(`${error}\n`);
        }
        process.exitCode = 1;
        return;
    }
    process.stdout.write(`WORKFLOW_REFERENCES_VALID: ${entries.length} workflows, ${referenceCount} references\n`);
}

module.exports = { scanWorkflowUses };

if (require.main === module) {
    try {
        main();
    } catch (error) {
        process.stderr.write(`${error.message}\n`);
        process.exitCode = 1;
    }
}
