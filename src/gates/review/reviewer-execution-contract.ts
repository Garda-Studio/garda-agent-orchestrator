export const REVIEWER_FOCUSED_SELF_VALIDATION_TOPIC = 'focused-self-validation';
export const REVIEWER_MISSING_FOCUSED_VALIDATION_MARKER =
    '[garda:evidence-only:missing-focused-validation]';
export const REVIEWER_MISSING_FOCUSED_TEST_ACTION = 'run-and-record-focused-test';
export const REVIEWER_MISSING_FOCUSED_VALIDATION_ACTION = 'run-and-record-focused-validation';
export const REVIEWER_MISSING_FOCUSED_TEST_MARKER_TEMPLATE =
    `${REVIEWER_MISSING_FOCUSED_VALIDATION_MARKER} test=<exact-repository-relative-test-path>; `
    + `action=${REVIEWER_MISSING_FOCUSED_TEST_ACTION}`;
export const REVIEWER_MISSING_FOCUSED_VALIDATION_MARKER_TEMPLATE =
    `${REVIEWER_MISSING_FOCUSED_VALIDATION_MARKER} target=<exact-repository-relative-validation-path>; `
    + `action=${REVIEWER_MISSING_FOCUSED_VALIDATION_ACTION}`;

export function buildReviewerFocusedSelfValidationContractLines(): string[] {
    return [
        '- Missing prior focused execution evidence is not by itself a finding or residual risk.',
        '- Only when the prospective finding is specifically that a relevant focused check may not have run, execute the smallest safe relevant local test or validation command yourself for exactly one relevant repository test or validation target file, with no unrelated or directory target, before deciding whether a finding exists.',
        '- The focused self-check must stay inside the authenticated review scope and must not invoke Garda, access network services implicitly, start background services, mutate source or control artifacts, use shell command chaining, substitution, or expansion, run a broad build/full suite, or duplicate current gate-owned evidence.',
        '- Record the exact attempted command, command_outcome (`passed`, `failed`, `unavailable`, or `prohibited`), and concise non-placeholder diagnostics that state the concrete result, failure, or prohibition in a validation_notes entry whose topic is `focused-self-validation`. The command must identify the one exact check target. Its authenticated changed-file evidence must explain why that target is relevant. For a passed command, evidence does not need to repeat the target path, even when the review reports a separate finding.',
        '- For a failed, unavailable, or prohibited focused command, put the exact command target path and its concrete relationship to changed behavior in at least one validation-note evidence.location or evidence.observation. Naming the target only in note, command, or diagnostics does not satisfy the evidence contract.',
        '- If the focused command passes, do not report missing prior execution as a finding or residual risk. If it exposes an actual defect or test failure, report that defect as an ordinary severity finding rather than as evidence-only F-000, link the failed validation note to the exact ordinary finding through finding_ids, and reuse at least one exact changed-file evidence location from each linked finding in that note.',
        `- Use reserved id \`F-000\` only after a real focused attempt is unavailable or prohibited, and make either its title or description exactly \`${REVIEWER_MISSING_FOCUSED_TEST_MARKER_TEMPLATE}\` or \`${REVIEWER_MISSING_FOCUSED_VALIDATION_MARKER_TEMPLATE}\`, replacing only the angle-bracketed path. A \`failed\` check represents actual failure evidence and must use an ordinary severity finding. The focused-self-validation note must preserve the exact command and actionable diagnostics.`
    ];
}

export function buildReviewerTerminalContractLines(): string[] {
    return [
        '- This reviewer-only handoff is not task implementation under repository AGENTS/start-task rules: do not open TASK.md or `.agents/workflows/start-task.md`, do not enter task mode, and do not act as the orchestrator.',
        '- Reviewer terminal contract: inspect only the authenticated scope, optionally run only the narrow focused self-validation exception, write exactly one review JSON object to ReviewOutputPath (or return that one object when writing is unavailable), then stop.',
        '- Never invoke Garda navigation, gate, launch, invocation, result, receipt, TASK.md, or project-memory commands; never record your own review result or continue the orchestration workflow.',
        '- Never launch a reviewer, subagent, or descendant agent, and never mutate source files, task state, reviewer control evidence, receipts, or other handoff artifacts.',
        '- The launcher/main agent exclusively owns delegation telemetry, result recording, downstream routing, completion, and cleanup after your single output is written.'
    ];
}
