import { URL } from 'node:url';

const INLINE_PROGRAM_PROTOCOLS = new Set(['data:', 'javascript:']);

function isInlineProgramUrl(value: string): boolean {
    try {
        return INLINE_PROGRAM_PROTOCOLS.has(new URL(value).protocol);
    } catch {
        return false;
    }
}

/** Rejects inline URL data; a normal return grants no execution authority. */
export function rejectInlineValidationProgramUrl(argument: string, isProgramOperand: boolean): void {
    if (typeof argument !== 'string' || typeof isProgramOperand !== 'boolean') {
        throw new TypeError('Program URL inspection requires literal string data and a boolean role');
    }

    const assignmentIndex = !isProgramOperand && argument.startsWith('-') ? argument.indexOf('=') : -1;
    const inlineOptionValue = assignmentIndex >= 0 && isInlineProgramUrl(argument.slice(assignmentIndex + 1));
    if (isInlineProgramUrl(argument) || inlineOptionValue) {
        throw new Error('Inline program URLs are not admissible');
    }
}
