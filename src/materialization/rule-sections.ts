export interface RuleSection { id: string; content: string }

const COMMAND_SLOTS = new Set(['setup', 'run', 'test', 'quality', 'compile-gate-mandatory', 'build-and-package']);
export const COMMAND_SLOT_TOKEN = '{{GARDA_PROJECT_COMMAND_SLOT}}';

export function splitRuleSections(content: string): RuleSection[] {
    const sections: RuleSection[] = [];
    let start = 0;
    let id = '';
    let fence: string | null = null;
    for (const match of content.matchAll(/[^\r\n]*(?:\r\n|\n|$)/gu)) {
        const line = match[0].replace(/\r?\n$/u, '');
        const delimiter = /^(?:`{3,}|~{3,})/u.exec(line)?.[0];
        if (delimiter) {
            if (!fence) fence = delimiter;
            else if (delimiter[0] === fence[0] && delimiter.length >= fence.length) fence = null;
            continue;
        }
        if (fence) continue;
        const heading = /^#{1,6} (.+)/u.exec(line)?.[1];
        const nextId = heading ? heading.toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-|-$/gu, '')
            : line.startsWith('Primary entry point:') ? 'preamble' : null;
        if (nextId === null) continue;
        if (match.index > start) sections.push({ id, content: content.slice(start, match.index) });
        start = match.index;
        id = nextId;
    }
    if (start < content.length) sections.push({ id, content: content.slice(start) });
    return sections;
}

export function commandSlot(section: RuleSection, file: string): { content: string; slot: string | null } {
    if (file !== '40-commands.md' || !COMMAND_SLOTS.has(section.id)) return { content: section.content, slot: null };
    const fence = /^(`{3,}|~{3,})[^\r\n]*\r?\n[\s\S]*?^\1[ \t]*(?:\r?\n|$)/mu.exec(section.content);
    if (!fence) return { content: section.content, slot: null };
    return { content: section.content.slice(0, fence.index) + COMMAND_SLOT_TOKEN + '\n' + section.content.slice(fence.index + fence[0].length), slot: fence[0] };
}

export function wrapRuleSection(section: RuleSection, file: string): string {
    const { content, slot } = commandSlot(section, file);
    const body = slot === null ? content : content.replace(COMMAND_SLOT_TOKEN + '\n', () =>
        `<!-- garda:project-command:${section.id}:start -->\n${slot}<!-- garda:project-command:${section.id}:end -->\n`);
    return `<!-- garda:rule-section:${section.id}:start -->\n${body}${body.endsWith('\n') ? '' : '\n'}<!-- garda:rule-section:${section.id}:end -->\n`;
}

export interface MarkedRuleSection { id: string; raw: string; body: string; index: number }
export function readMarkedRuleSections(content: string): MarkedRuleSection[] | null {
    const pattern = /^<!-- garda:rule-section:([a-z0-9-]+):start -->\r?\n([\s\S]*?)^<!-- garda:rule-section:\1:end -->[ \t]*(?:\r?\n|$)/gmu;
    const matches = [...content.matchAll(pattern)];
    const ids = new Set<string>();
    for (const match of matches) {
        if (ids.has(match[1]) || match[2].includes('<!-- garda:rule-section:')) return null;
        ids.add(match[1]);
    }
    if (content.replace(pattern, '').includes('<!-- garda:rule-section:')) return null;
    return matches.map(match => ({ id: match[1], raw: match[0], body: match[2], index: match.index }));
}

export function replaceProjectCommands(template: string, live: string): string | null {
    const pattern = /^<!-- garda:project-command:([a-z0-9-]+):start -->\r?\n([\s\S]*?)^<!-- garda:project-command:\1:end -->[ \t]*(?:\r?\n|$)/gmu;
    const commands = new Map<string, string>();
    for (const match of live.matchAll(pattern)) {
        if (commands.has(match[1]) || match[2].includes('<!-- garda:project-command:')) return null;
        commands.set(match[1], match[2]);
    }
    if (live.replace(pattern, '').includes('<!-- garda:project-command:')) return null;
    const expected = [...template.matchAll(pattern)].map(match => match[1]);
    if (expected.length !== commands.size || expected.some(id => !commands.has(id))) return null;
    const used = new Set<string>();
    const result = template.replace(pattern, (raw, id: string) => {
        const command = commands.get(id);
        if (command === undefined) return raw;
        used.add(id);
        return `<!-- garda:project-command:${id}:start -->\n${command}<!-- garda:project-command:${id}:end -->\n`;
    });
    return used.size === commands.size ? result : null;
}
