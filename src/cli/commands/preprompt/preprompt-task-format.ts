import type { ProjectMemoryBrief } from './preprompt-task-context';
import type { PrepromptContinuation } from './preprompt-task-commands';
import type { TaskContextSelection } from './preprompt-task-context-selection';
import { isMandatoryOptionalSkillSelectionPolicyMode } from '../../../runtime/optional-skill-selection';

export function buildPrepromptHelpText(): string {
    return [
        'Command: preprompt task',
        'Build a read-only schema 3 task brief with the current validated navigator action. Revalidate before acting.',
        '',
        'Usage:',
        '  garda preprompt task --task-id "<task-id>" --json --target-root "."',
        '  garda preprompt task --task-id "<task-id>" --target-root "."',
        '',
        'Options:',
        '  --task-id <task-id>        Required task id from TASK.md.',
        '  --json                     Emit machine-readable JSON.',
        '  --target-root <path>      Optional workspace root. Defaults to ".".',
        '  --init-answers-path <p>   Optional init-answers artifact path override.',
        '  -h, --help                Show this help and exit.'
    ].join('\n');
}

export function formatTaskBriefText(result: Record<string, unknown>): string {
    const task = result.task as Record<string, unknown>;
    const projectMemory = result.project_memory as ProjectMemoryBrief | undefined;
    const commands = result.commands as Record<string, unknown>;
    const continuation = result.continuation as PrepromptContinuation;
    const contextSelection = result.context_selection as TaskContextSelection | undefined;
    const optionalSkillTaskStartBlocker = getOptionalSkillTaskStartBlocker(result);
    const lines = [
        'GARDA_PREPROMPT_TASK',
        `Task: ${String(task?.id || '')}`,
        `CurrentStage: ${String(task?.current_stage || 'unknown')}`,
        `ContinuationStatus: ${continuation.status}`,
        `NextAction: ${continuation.action?.label || continuation.title}`,
        `NextCommand: ${continuation.action?.command || 'none'}`,
        `CommandSelectionRequired: ${continuation.action?.command_selection_required === true}`,
        `Reason: ${continuation.reason}`,
        `RevalidateBeforeAction: ${continuation.navigator_command}`
    ];
    if (contextSelection) {
        lines.push(
            `ControllerPhase: ${contextSelection.phase}`,
            'ControllerReadSet:',
            ...contextSelection.controller_read_set.map(entry => `  - ${entry.path}: ${entry.sections.join('; ')}${entry.task_id ? ` (row ${entry.task_id} and Notes)` : ''}`),
            'BeforeCodeEdit: revalidate with next-step and read context_selection.before_code_edit_read_set; load implementation instructions before any source or test edit, including a new failure or requested change.',
            'MissingInstructionSection: read the full source and before_code_edit_read_set before acting; use navigator diagnostics if required instructions remain unavailable.',
            'SessionKnowledge: historical RULE_PACK_LOADED is not proof that this session read the instructions.',
            'ReviewerContext: use the exact generated launch input, required skill and generated context in a fresh isolated reviewer; repository rule files stay empty.'
        );
    }
    if (projectMemory) {
        lines.push(
            `ProjectMemoryStatus: ${projectMemory.status}`,
            `ProjectMemoryState: initialized=${projectMemory.initialization_state.initialized}; validated=${projectMemory.initialization_state.validated}; pending=${projectMemory.initialization_state.pending}`,
            `ProjectMemorySummaryRule: ${projectMemory.summary_rule}`,
            'ProjectMemoryReadFirst:',
            ...projectMemory.read_first.map((entry) => `  - ${entry}`),
            'ProjectMemorySuggested:',
            ...(projectMemory.suggested_files.length > 0
                ? projectMemory.suggested_files.map((entry) => `  - ${entry}`)
                : ['  none']),
            `ProjectMemoryFallback: ${projectMemory.unknown_custom_stack_fallback}`,
            'ProjectMemoryTaskStartGuidance:',
            ...projectMemory.task_start_guidance.map((entry) => `  - ${entry}`)
        );
        if (projectMemory.init_refresh_prompt) {
            lines.push(`ProjectMemoryInitRefreshPrompt: ${projectMemory.init_refresh_prompt}`);
        }
        if (projectMemory.warnings.length > 0) {
            lines.push(
                'ProjectMemoryWarnings:',
                ...projectMemory.warnings.map((entry) => `  - ${entry}`)
            );
        }
    }
    if (optionalSkillTaskStartBlocker) {
        lines.push(`OptionalSkillTaskStartBlocker: ${optionalSkillTaskStartBlocker}`);
    }
    const optionalSkillTaskStartInstruction = getOptionalSkillTaskStartInstruction(result);
    if (optionalSkillTaskStartInstruction) {
        lines.push(`OptionalSkillTaskStartInstruction: ${optionalSkillTaskStartInstruction}`);
    }
    const startupScopeBlocker = String(commands?.startup_scope_blocker || '').trim();
    if (startupScopeBlocker) {
        lines.push(`StartupScopeBlocker: ${startupScopeBlocker}`);
    }
    const startupCommands = Array.isArray(commands?.startup_commands) ? commands.startup_commands : [];
    if (commands.startup_pending === true) {
        lines.push(
            'StartupCommands:',
            ...(startupCommands.length > 0
                ? startupCommands.map((entry) => `  - ${String(entry)}`)
                : ['  none'])
        );
    }
    return `${lines.join('\n')}\n`;
}

export function getOptionalSkillTaskStartBlocker(result: Record<string, unknown>): string | null {
    const diagnostics = result.diagnostics;
    if (!diagnostics || typeof diagnostics !== 'object' || Array.isArray(diagnostics)) {
        return null;
    }
    const optionalSkills = (diagnostics as Record<string, unknown>).optional_skills;
    if (!optionalSkills || typeof optionalSkills !== 'object' || Array.isArray(optionalSkills)) {
        return null;
    }
    const policyMode = String(
        (optionalSkills as Record<string, unknown>).current_policy_mode
        || (optionalSkills as Record<string, unknown>).policy_mode
        || ''
    ).trim().toLowerCase();
    const blocker = String((optionalSkills as Record<string, unknown>).blocker || '').trim();
    if (!blocker) {
        return null;
    }
    if (!policyMode) {
        return blocker;
    }
    if (!isMandatoryOptionalSkillSelectionPolicyMode(policyMode)) {
        return null;
    }
    return blocker;
}

export function getOptionalSkillTaskStartInstruction(result: Record<string, unknown>): string | null {
    const contextSelection = result.context_selection as TaskContextSelection | undefined;
    if (contextSelection?.implementation_instructions_deferred === true) return null;
    const diagnostics = result.diagnostics;
    if (!diagnostics || typeof diagnostics !== 'object' || Array.isArray(diagnostics)) {
        return null;
    }
    const optionalSkills = (diagnostics as Record<string, unknown>).optional_skills;
    if (!optionalSkills || typeof optionalSkills !== 'object' || Array.isArray(optionalSkills)) {
        return null;
    }
    const instruction = String((optionalSkills as Record<string, unknown>).task_start_instruction || '').trim();
    return instruction || null;
}
