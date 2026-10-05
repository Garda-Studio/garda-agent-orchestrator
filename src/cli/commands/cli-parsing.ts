import * as fs from 'node:fs';
import {
    ALL_AGENT_ENTRYPOINT_FILES,
    BOOLEAN_FALSE_VALUES,
    BOOLEAN_TRUE_VALUES,
    BREVITY_VALUES,
    DEFAULT_SOURCE_OF_TRUTH,
    SOURCE_OF_TRUTH_VALUES
} from '../../core/constants';
import {
    getCanonicalEntrypointFile,
    normalizeAgentEntrypointToken as normalizeCommonAgentEntrypointToken
} from '../../materialization/common';
import { normalizeProviderId } from '../../core/provider-registry';
import { validateParsedCliPathInputs } from '../../core/cli-path-input-policy';
import { getAgentInitPromptPath, resolvePathInsideRoot } from './cli-bundle-helpers';

type ParsedOptionValue = string | boolean | string[] | undefined;
type OptionDefinitions = Record<string, { key: string; type: string }>;

export interface GlobalFlags {
    noColor: boolean;
    offline: boolean;
    forceNetwork: boolean;
    rest: string[];
}

export function extractGlobalFlags(argv: string[]): GlobalFlags {
    let noColor = false;
    let offline = false;
    let forceNetwork = false;
    const rest: string[] = [];
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === '--no-color') {
            noColor = true;
        } else if (arg === '--offline') {
            offline = true;
        } else if (arg === '--force-network') {
            forceNetwork = true;
        } else {
            rest.push(arg);
        }
    }
    return { noColor, offline, forceNetwork, rest };
}

export function parseOptions(
    argv: string[],
    definitions: OptionDefinitions,
    config?: { allowPositionals?: boolean; maxPositionals?: number }
): { options: Record<string, ParsedOptionValue>; positionals: string[] } {
    const allowPositionals = (config && config.allowPositionals) || false;
    const maxPositionals = (config && config.maxPositionals) || 0;
    const options: Record<string, ParsedOptionValue> = {};
    const positionals: string[] = [];

    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];

        if (argument === '-h' || argument === '--help') { options.help = true; continue; }
        if (argument === '-v' || argument === '--version') { options.version = true; continue; }

        if (!argument.startsWith('-')) {
            if (!allowPositionals) throw new Error(`Unexpected positional argument: ${argument}`);
            positionals.push(argument);
            if (positionals.length > maxPositionals) throw new Error('Too many positional arguments were provided.');
            continue;
        }

        const equalsIndex = argument.indexOf('=');
        const optionName = equalsIndex >= 0 ? argument.slice(0, equalsIndex) : argument;
        const inlineValue = equalsIndex >= 0 ? argument.slice(equalsIndex + 1) : undefined;
        const definition = definitions[optionName];
        if (!definition) throw new Error(`Unknown option: ${argument}`);

        if (definition.type === 'boolean') {
            if (inlineValue !== undefined) {
                options[definition.key] = parseBooleanText(inlineValue, optionName);
            } else if (index + 1 < argv.length && !argv[index + 1].startsWith('-') && isBooleanText(argv[index + 1])) {
                index += 1;
                options[definition.key] = parseBooleanText(argv[index], optionName);
            } else {
                options[definition.key] = true;
            }
            continue;
        }

        let resolvedValue = inlineValue;
        if (resolvedValue === undefined) {
            if (index + 1 >= argv.length) throw new Error(`${optionName} requires a value.`);
            resolvedValue = argv[index + 1];
            const nextOptionName = resolvedValue.split('=', 1)[0];
            if (Object.hasOwn(definitions, nextOptionName)
                || ['-h', '--help', '-v', '--version'].includes(nextOptionName)) {
                throw new Error(`${optionName} requires a value before ${nextOptionName}. To pass an option name literally, use ${optionName}=<value>.`);
            }
            index += 1;
        }
        if (definition.type === 'string[]') {
            const existingValue = options[definition.key];
            const values = Array.isArray(existingValue) ? existingValue : [];
            values.push(resolvedValue);
            options[definition.key] = values;
        } else {
            options[definition.key] = resolvedValue;
        }
    }

    validateParsedCliPathInputs(definitions, options);
    return { options, positionals };
}

export function normalizeLogicalKey(value: unknown): string {
    return String(value || '').toLowerCase().replace(/[_\-\s]/g, '');
}

export function getInitAnswerValue(answers: Record<string, unknown>, logicalName: string): unknown {
    const targetKey = normalizeLogicalKey(logicalName);
    for (const [key, value] of Object.entries(answers)) {
        if (normalizeLogicalKey(key) === targetKey) return value;
    }
    return null;
}

export function isBooleanText(text: string): boolean {
    const normalized = text.trim().toLowerCase();
    return BOOLEAN_TRUE_VALUES.includes(normalized) || BOOLEAN_FALSE_VALUES.includes(normalized);
}

export function parseBooleanText(value: unknown, label: string): boolean {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value) && (value === 0 || value === 1)) return value === 1;
    if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase();
        if (BOOLEAN_TRUE_VALUES.includes(normalized)) return true;
        if (BOOLEAN_FALSE_VALUES.includes(normalized)) return false;
    }
    throw new Error(`${label} must be one of: true, false, yes, no, 1, 0.`);
}

export function tryParseBooleanText(value: unknown, fallback: boolean): boolean {
    try {
        return value === undefined || value === null || String(value).trim() === ''
            ? fallback
            : parseBooleanText(value, 'boolean');
    } catch (_error) {
        return fallback;
    }
}

export function parseOptionalText(value: unknown): string | null {
    if (value === undefined || value === null) return null;
    if (Array.isArray(value)) {
        const items = value.map((item: unknown): string => String(item || '').trim()).filter(Boolean);
        return items.length > 0 ? items.join(', ') : null;
    }
    const text = String(value).trim();
    return text || null;
}

export function parseRequiredText(value: unknown, label: string): string {
    const text = String(value || '').trim();
    if (!text) throw new Error(`${label} must not be empty.`);
    return text;
}

export function normalizeSourceOfTruth(value: unknown): string {
    const text = parseRequiredText(value, 'SourceOfTruth');
    const match = normalizeProviderId(text);
    if (!match) throw new Error(`SourceOfTruth must be one of: ${SOURCE_OF_TRUTH_VALUES.join(', ')}.`);
    return match;
}

export function tryNormalizeSourceOfTruth(value: unknown, fallback = DEFAULT_SOURCE_OF_TRUTH): string {
    try {
        return value === undefined || value === null || String(value).trim() === ''
            ? fallback
            : normalizeSourceOfTruth(value);
    } catch (_error) {
        return fallback;
    }
}

export function normalizeAssistantBrevity(value: unknown): string {
    const text = parseRequiredText(value, 'AssistantBrevity').toLowerCase();
    if (!BREVITY_VALUES.includes(text)) {
        throw new Error(`AssistantBrevity must be one of: ${BREVITY_VALUES.join(', ')}.`);
    }
    return text;
}

export function tryNormalizeAssistantBrevity(value: unknown, fallback = 'concise'): string {
    try {
        return value === undefined || value === null || String(value).trim() === ''
            ? fallback
            : normalizeAssistantBrevity(value);
    } catch (_error) {
        return fallback;
    }
}

export function convertSourceOfTruthToEntrypoint(sourceOfTruth: string): string | null {
    try {
        return getCanonicalEntrypointFile(sourceOfTruth);
    } catch (_error) {
        return null;
    }
}

export function normalizeAgentEntrypointToken(value: unknown): string | null {
    try {
        return normalizeCommonAgentEntrypointToken(String(value || ''));
    } catch (_error) {
        return null;
    }
}

export function normalizeActiveAgentFiles(value: unknown, sourceOfTruth: string): string | null {
    const canonicalEntrypoint = convertSourceOfTruthToEntrypoint(sourceOfTruth);
    const tokens = parseOptionalText(value)
        ? String(value).split(/[;,]+/).map(normalizeAgentEntrypointToken).filter((token): token is string => token !== null)
        : [];
    const unique = new Set(tokens);
    if (canonicalEntrypoint) unique.add(canonicalEntrypoint);
    const ordered = ALL_AGENT_ENTRYPOINT_FILES.filter((entry) => unique.has(entry));
    return ordered.length > 0 ? ordered.join(', ') : null;
}

export function normalizeCollectedVia(value: unknown): string {
    const text = parseOptionalText(value);
    return text || 'AGENT_INIT_PROMPT.md';
}

export function readInitAnswersArtifact(targetRoot: string, initAnswersPath: string, bundlePath: string, commandName: string) {
    const resolvedPath = resolvePathInsideRoot(targetRoot, initAnswersPath, 'InitAnswersPath', { allowMissing: true });
    if (!fs.existsSync(resolvedPath)) {
        throw new Error(
            `Init answers file is missing for '${commandName}'. ` +
            `Expected at: ${resolvedPath}\n` +
            `Give your agent "${getAgentInitPromptPath(bundlePath)}" to produce the init answers first.`
        );
    }
    const raw = fs.readFileSync(resolvedPath, 'utf8');
    if (!raw.trim()) throw new Error(`Init answers artifact is empty: ${resolvedPath}`);
    let answers: Record<string, unknown>;
    try {
        answers = JSON.parse(raw);
    } catch (_error) {
        throw new Error(`Init answers artifact is not valid JSON: ${resolvedPath}`);
    }
    const assistantLanguage = parseRequiredText(getInitAnswerValue(answers, 'AssistantLanguage'), 'AssistantLanguage');
    const assistantBrevity = normalizeAssistantBrevity(getInitAnswerValue(answers, 'AssistantBrevity'));
    const sotValue = normalizeSourceOfTruth(getInitAnswerValue(answers, 'SourceOfTruth'));
    const enforceNoAutoCommit = parseBooleanText(getInitAnswerValue(answers, 'EnforceNoAutoCommit') ?? false, 'EnforceNoAutoCommit');
    const claudeOrchestratorFullAccess = parseBooleanText(getInitAnswerValue(answers, 'ClaudeOrchestratorFullAccess'), 'ClaudeOrchestratorFullAccess');
    const tokenEconomyEnabled = parseBooleanText(getInitAnswerValue(answers, 'TokenEconomyEnabled') ?? false, 'TokenEconomyEnabled');
    const providerMinimalism = parseBooleanText(getInitAnswerValue(answers, 'ProviderMinimalism') ?? true, 'ProviderMinimalism');
    const collectedVia = normalizeCollectedVia(getInitAnswerValue(answers, 'CollectedVia'));
    const activeAgentFiles = parseOptionalText(getInitAnswerValue(answers, 'ActiveAgentFiles'));

    return {
        resolvedPath,
        assistantLanguage,
        assistantBrevity,
        sourceOfTruth: sotValue,
        enforceNoAutoCommit,
        claudeOrchestratorFullAccess,
        tokenEconomyEnabled,
        providerMinimalism,
        collectedVia,
        activeAgentFiles
    };
}
