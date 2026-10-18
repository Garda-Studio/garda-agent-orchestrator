import type { ValidationAttempt, ValidationCase, ValidationRecipe } from './project-validation-contract';

const MAXIMUM_CASES = 1024;
export type ValidationResultStatus = 'PASSED' | 'FAILED' | 'EXPECTED_FAILURE' | 'UNEXPECTED_PASS' | 'UNRESOLVED';
type HostFacts = Pick<ValidationAttempt, 'exit_code' | 'timed_out' | 'cancelled' | 'truncated' | 'violations' | 'termination_signal'>;

export function isCompleteExpectedFailureAttempt(facts: HostFacts): boolean {
    return Number.isSafeInteger(facts.exit_code) && facts.exit_code > 0 && facts.timed_out === false
        && facts.cancelled === false && facts.truncated === false && !facts.termination_signal && facts.violations.length === 0;
}

export function parseValidationTap(output: string): ValidationCase[] {
    const cases: ValidationCase[] = []; let plan: number | null = null, diagnostics = false;
    for (const line of output.split(/\r?\n/u)) {
        if (/^\s+---\s*$/u.test(line) && cases.length && !diagnostics) { diagnostics = true; continue; }
        if (diagnostics) {
            if (/^\s+\.\.\.\s*$/u.test(line)) diagnostics = false;
            else if (!/^\s/u.test(line)) throw new Error('Malformed TAP diagnostics');
            continue;
        }
        if (!line.trim() || /^\s*#/u.test(line) || /^TAP version 1[34]$/u.test(line)) continue;
        const planned = /^1\.\.(\d+)\s*$/u.exec(line);
        if (planned) { if (plan !== null) throw new Error('Duplicate TAP plan'); plan = Number(planned[1]); continue; }
        const result = /^(not ok|ok)\s+(\d+)\s+-\s+(.+?)(?:\s+#\s+(SKIP|TODO)\b.*)?$/iu.exec(line);
        if (!result || Number(result[2]) !== cases.length + 1 || cases.length >= MAXIMUM_CASES) throw new Error('Unsupported or malformed TAP');
        cases.push({ id: result[3], outcome: result[4] ? 'skipped' : result[1].toLowerCase() === 'ok' ? 'passed' : 'failed' });
    }
    if (diagnostics || plan !== cases.length || !cases.length || new Set(cases.map(entry => entry.id)).size !== cases.length) throw new Error('TAP requires a nonempty exact plan and unique cases');
    return cases;
}
export function summarizeValidationResults(recipe: ValidationRecipe, facts: HostFacts, output: string, expectedFailure = false): { status: ValidationResultStatus; cases: ValidationCase[] | null } {
    if (facts.timed_out || facts.cancelled || facts.truncated || facts.violations.length || facts.termination_signal) return { status: 'FAILED', cases: null };
    if (recipe.result_format !== 'tap' || !recipe.targets.length) return { status: 'UNRESOLVED', cases: null };
    let cases: ValidationCase[];
    try { cases = parseValidationTap(output); } catch { return { status: 'UNRESOLVED', cases: null }; }
    const exact = cases.length === recipe.targets.length && recipe.targets.every(target => cases.some(entry => entry.id === target.selector));
    if (!exact || cases.some(entry => entry.outcome === 'skipped')) return { status: 'FAILED', cases };
    const failed = cases.some(entry => entry.outcome === 'failed');
    const status = expectedFailure && failed && facts.exit_code > 0 ? 'EXPECTED_FAILURE'
        : !failed && facts.exit_code === 0 ? expectedFailure ? 'UNEXPECTED_PASS' : 'PASSED' : 'FAILED';
    return { status, cases };
}
