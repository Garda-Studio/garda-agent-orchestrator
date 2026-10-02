import type { PrepromptContinuation } from './preprompt-task-commands';

type ControllerPhase = 'implementation' | 'review_orchestration' | 'docs_memory_closeout' | 'completion';

export interface InstructionReadSource {
    path: string;
    sections: string[];
    task_id?: string;
}

export interface TaskContextSelection {
    schema_version: 1;
    source: 'next-step';
    phase: ControllerPhase;
    advisory_only: true;
    revalidate_before_action: true;
    navigator_command: string;
    implementation_instructions_deferred: boolean;
    historical_rule_pack_is_session_knowledge: false;
    missing_section_fallback: 'full_source_and_implementation_context';
    controller_read_set: InstructionReadSource[];
    before_code_edit_read_set: InstructionReadSource[];
    reviewer_context: {
        source: 'generated_launch_input';
        repository_rule_files: [];
        required_skill_and_generated_context: true;
        fresh_isolated_context: true;
    };
}

interface ContextSelectionInput {
    continuation: PrepromptContinuation;
    canonicalEntrypoint: string | null;
    bundlePath: string;
    optionalSkillPaths: string[];
    projectMemoryReadFirst: string[];
}

const REVIEW_GATES = new Set([
    'build-scoped-diff', 'build-review-context', 'record-review-routing', 'prepare-reviewer-launch',
    'record-reviewer-delegation-started', 'complete-reviewer-launch', 'record-reviewer-launch-failed',
    'record-review-invocation', 'record-review-result', 'required-reviews-check', 'full-suite-validation'
]);
const CLOSEOUT_GATES = new Set(['doc-impact-gate', 'project-memory-impact']);
const COMPLETION_GATES = new Set(['completion-gate', 'task-audit-summary']);

function selectControllerPhase(input: ContextSelectionInput): ControllerPhase {
    const { status, next_gate: gate } = input.continuation;
    if (!input.canonicalEntrypoint) return 'implementation';
    if (status === 'DONE' && gate === null) return 'completion';
    if (status !== 'READY' && status !== 'BLOCKED') return 'implementation';
    if (gate && REVIEW_GATES.has(gate)) return 'review_orchestration';
    if (gate && CLOSEOUT_GATES.has(gate)) return 'docs_memory_closeout';
    if (gate && COMPLETION_GATES.has(gate)) return 'completion';
    return 'implementation';
}

function buildControllerReadSet(input: ContextSelectionInput, phase: ControllerPhase): InstructionReadSource[] {
    const rules = `${input.bundlePath}/live/docs/agent-rules`;
    const workflowSections = phase === 'implementation' ? ['*'] : [
        'Integrity Priority Rules', 'Task Resume Protocol', 'Task Execution And Approval', 'Final User Report And Commit'
    ];
    const skillSections = phase === 'implementation' ? ['*'] : ['Phase-Scoped Resume Context'];
    if (phase === 'review_orchestration') {
        workflowSections.push('Review Orchestration', 'Documentation And Memory Closeout');
        skillSections.push('Findings-Only Review Lifecycle', 'Reviewer Agent Execution (Platform-Agnostic)');
    } else if (phase === 'docs_memory_closeout') {
        workflowSections.push('Documentation And Memory Closeout', 'Completion And Audit');
    } else if (phase === 'completion') {
        workflowSections.push('Completion And Audit');
    }
    const reads: InstructionReadSource[] = [
        { path: input.canonicalEntrypoint || 'AGENTS.md', sections: ['*'] },
        { path: '.agents/workflows/start-task.md', sections: ['Start Task'] },
        { path: 'TASK.md', sections: ['Active Queue'], task_id: input.continuation.task_id },
        { path: `${rules}/00-core.md`, sections: ['*'] },
        { path: `${rules}/80-task-workflow.md`, sections: workflowSections },
        { path: `${input.bundlePath}/live/skills/orchestration/SKILL.md`, sections: skillSections }
    ];
    if (phase === 'implementation') {
        for (const name of ['35-strict-coding-rules', '40-commands', '50-structure-and-docs', '70-security', '90-skill-catalog']) {
            reads.push({ path: `${rules}/${name}.md`, sections: ['*'] });
        }
        for (const skillPath of input.optionalSkillPaths) reads.push({ path: skillPath, sections: ['*'] });
    } else {
        reads.push({ path: `${rules}/40-commands.md`, sections: ['Compact Command Policy', 'Required Protocol', 'Auditable Intermediate Commands', 'Manual Validation Logs'] });
    }
    if (phase === 'implementation' || phase === 'docs_memory_closeout') {
        for (const memoryPath of input.projectMemoryReadFirst) reads.push({ path: memoryPath, sections: ['*'] });
    }
    return reads;
}

export function buildTaskContextSelection(input: ContextSelectionInput): TaskContextSelection {
    const phase = selectControllerPhase(input);
    return {
        schema_version: 1,
        source: 'next-step',
        phase,
        advisory_only: true,
        revalidate_before_action: true,
        navigator_command: input.continuation.navigator_command,
        implementation_instructions_deferred: phase !== 'implementation',
        historical_rule_pack_is_session_knowledge: false,
        missing_section_fallback: 'full_source_and_implementation_context',
        controller_read_set: buildControllerReadSet(input, phase),
        before_code_edit_read_set: buildControllerReadSet(input, 'implementation'),
        reviewer_context: {
            source: 'generated_launch_input',
            repository_rule_files: [],
            required_skill_and_generated_context: true,
            fresh_isolated_context: true
        }
    };
}
