import { normalizePath } from './helpers';

export interface OperatorNextActionBlockInput {
    status?: string | null;
    gate?: string | null;
    action: string;
    reason?: string | null;
    command?: string | null;
    commandReference?: string | null;
    /** One short line telling the agent what to do when there is no executable command. */
    nextInstruction?: string | null;
    detailsPath?: string | null;
    detailsHint?: string | null;
}

const MAX_REASON_CHARS = 220;
// Without an executable command the reason is the operator's only instruction; keep it readable.
const MAX_COMMANDLESS_REASON_CHARS = 1_200;

function compactOperatorText(value: string | null | undefined, maxChars = MAX_REASON_CHARS): string {
    const compact = String(value || '').replace(/\s+/g, ' ').trim();
    if (compact.length <= maxChars) {
        return compact;
    }
    return `${compact.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

export function buildOperatorNextActionBlock(input: OperatorNextActionBlockInput): string[] {
    const lines = ['Next action:'];
    if (input.status) {
        lines.push(`  Status: ${compactOperatorText(input.status, 80)}`);
    }
    if (input.gate) {
        lines.push(`  Gate: ${compactOperatorText(input.gate, 80)}`);
    }
    lines.push(`  Do: ${compactOperatorText(input.action, 160) || 'Inspect details before continuing.'}`);
    if (input.reason) {
        lines.push(`  Reason: ${compactOperatorText(input.reason,
            input.command ? MAX_REASON_CHARS : MAX_COMMANDLESS_REASON_CHARS)}`);
    }
    if (input.command) {
        lines.push(`  Command: ${input.command}`);
    } else {
        lines.push('  Command: none');
        if (input.nextInstruction) {
            lines.push(`  Next: ${input.nextInstruction}`);
        }
    }
    const contradictsCommand = Boolean(input.command)
        && /no executable command is available/iu.test(input.commandReference || '');
    if (input.commandReference && !contradictsCommand) {
        lines.push(`  CommandReference: ${compactOperatorText(input.commandReference, 160)}`);
    }
    if (input.detailsPath) {
        lines.push(`  DetailsPath: ${normalizePath(input.detailsPath)}`);
    }
    if (input.detailsHint) {
        lines.push(`  Details: ${compactOperatorText(input.detailsHint, 180)}`);
    }
    return lines;
}
