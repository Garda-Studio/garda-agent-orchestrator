import { LEGACY_RULE_SECTIONS } from './legacy-rule-sections';
import {
    COMMAND_SLOT_TOKEN, commandSlot, readMarkedRuleSections, replaceProjectCommands,
    splitRuleSections, type RuleSection
} from './rule-sections';

export const GARDA_OWNED_RULE_FILES = Object.freeze([
    '00-core.md', '35-strict-coding-rules.md', '70-security.md', '80-task-workflow.md', '90-skill-catalog.md'
]);
export const MIXED_RULE_FILES = Object.freeze(['40-commands.md', '50-structure-and-docs.md', '60-operating-rules.md']);
const LEGACY_ANCHORS: Record<string, string[]> = {
    '40-commands.md': ['preamble', 'compact-command-policy', 'agent-gates', 'compile-gate-mandatory'],
    '50-structure-and-docs.md': ['repository-structure', 'core-documents', 'orchestrator-git-boundary'],
    '60-operating-rules.md': ['general', 'execution-depth', 'stack-specific-rules', 'devops']
};
export interface RuleRefreshResult { content: string; warning: string | null }

function preserved(content: string, file: string, reason: string): RuleRefreshResult {
    return { content, warning: `${file} preserved: unrecognized rule structure (${reason}); reconcile project sections before refreshing Garda guidance.` };
}

// A known shipped section must remain an ordered subsequence. Only additional spans can
// be project additions; deletions/replacements cannot establish Garda ownership safely.
function projectAdditions(content: string, known: string): { additions: string; ambiguous: boolean } | null {
    const lines = [...content.matchAll(/[^\r\n]*(?:\r\n|\n|$)/gu)];
    const expected = known.split(/\r?\n/u).filter(line => line.trim());
    const positions: number[] = [];
    let cursor = 0;
    let offset = 0;
    let additions = '';
    for (const line of expected) {
        let index = cursor;
        while (index < lines.length && lines[index][0].replace(/\r?\n$/u, '') !== line) index++;
        if (index === lines.length) return null;
        positions.push(index);
        const gap = content.slice(offset, lines[index].index);
        if (gap.trim()) additions += gap;
        offset = lines[index].index + lines[index][0].length;
        cursor = index + 1;
    }
    const tail = content.slice(offset);
    if (tail.trim()) additions += tail;
    let reverseCursor = lines.length - 1;
    for (let expectedIndex = expected.length - 1; expectedIndex >= 0; expectedIndex--) {
        while (reverseCursor >= 0 && lines[reverseCursor][0].replace(/\r?\n$/u, '') !== expected[expectedIndex]) reverseCursor--;
        if (reverseCursor !== positions[expectedIndex]) return { additions: '', ambiguous: true };
        reverseCursor--;
    }
    return { additions, ambiguous: false };
}

function migrateLegacySection(section: RuleSection, file: string, template: string): string | null {
    const { content, slot } = commandSlot(section, file);
    const variants = LEGACY_RULE_SECTIONS[file]?.[section.id] || [];
    for (const known of [...variants].sort((a, b) => b.length - a.length)) {
        const match = projectAdditions(content, known);
        if (match === null) continue;
        if (match.ambiguous) return null;
        const { additions } = match;
        if (additions.includes(COMMAND_SLOT_TOKEN)) return null;
        if (slot === null) return template + additions;
        const replacement = template.replace(
            /(^<!-- garda:project-command:[a-z0-9-]+:start -->\r?\n)[\s\S]*?(^<!-- garda:project-command:[a-z0-9-]+:end -->)/mu,
            (_raw, start: string, end: string) => start + slot + end
        );
        return replacement === template && !template.includes(slot) ? null : replacement + additions;
    }
    return null;
}

export function refreshMixedRule(liveContent: string | Buffer, template: string, file: string): RuleRefreshResult {
    const content = typeof liveContent === 'string' ? liveContent : liveContent.toString('utf8');
    if (Buffer.isBuffer(liveContent) && !Buffer.from(content, 'utf8').equals(liveContent)) {
        return preserved(content, file, 'invalid UTF-8; byte-preserving migration unavailable');
    }
    const templateSections = readMarkedRuleSections(template);
    if (!templateSections?.length) return preserved(content, file, 'template ownership markers unavailable');
    const templates = new Map(templateSections.map(section => [section.id, section.raw]));
    const used = new Set<string>();
    let refreshed = '';
    if (content.includes('<!-- garda:rule-section:')) {
        const sections = readMarkedRuleSections(content);
        if (!sections?.length) return preserved(content, file, 'malformed or duplicate ownership markers');
        let offset = 0;
        for (const section of sections) {
            const replacement = templates.get(section.id);
            if (!replacement) return preserved(content, file, `unknown managed section ${section.id}`);
            const merged = replaceProjectCommands(replacement, section.raw);
            if (merged === null) return preserved(content, file, `ambiguous project commands in ${section.id}`);
            refreshed += content.slice(offset, section.index) + merged;
            offset = section.index + section.raw.length;
            used.add(section.id);
        }
        refreshed += content.slice(offset);
    } else {
        const sections = splitRuleSections(content);
        if (!(LEGACY_ANCHORS[file] || []).every(id => sections.some(section => section.id === id))) {
            return preserved(content, file, 'required Garda headings unavailable');
        }
        for (const section of sections) {
            const replacement = templates.get(section.id);
            if (!replacement) {
                refreshed += section.content;
                continue;
            }
            if (used.has(section.id)) return preserved(content, file, `duplicate Garda heading ${section.id}`);
            const merged = migrateLegacySection(section, file, replacement);
            if (merged === null) return preserved(content, file, `customized Garda heading ${section.id}`);
            refreshed += merged;
            used.add(section.id);
        }
    }
    for (const section of templateSections) {
        if (!used.has(section.id)) refreshed += '\n' + section.raw;
    }
    return { content: refreshed, warning: null };
}
