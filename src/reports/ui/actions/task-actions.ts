import { buildUiActionDefinition } from './action-common';
import type { UiActionDefinition } from './types';

export const TASK_RESET_REOPEN_ACTION_ID = 'task-reset-reopen';
export const TASK_RESET_CLOSE_ACTION_ID = 'task-reset-discard';
export const TASK_RESET_REOPEN_CONFIRMATION_PHRASE = 'RESET TASK';
export const TASK_RESET_CLOSE_CONFIRMATION_PHRASE = 'CLOSE WITHOUT EXECUTION';

export function buildUiTaskActionDefinitions(repoRoot: string, taskId: string): UiActionDefinition[] {
    return [
        buildUiActionDefinition(
            repoRoot,
            'task-next-step',
            'Task',
            'Next lifecycle step',
            'Run the task router and print the next required lifecycle command.',
            ['next-step', taskId, '--repo-root', repoRoot],
            { mutates: true, confirmationPhrase: 'RUN TASK NEXT STEP' }
        ),
        buildUiActionDefinition(
            repoRoot,
            TASK_RESET_REOPEN_ACTION_ID,
            'Task',
            'Reset task',
            'Reset this task through the guarded task-reset gate and reopen it for a fresh lifecycle run. The local UI uses confirmed one-action native authority without changing permanent reset policy.',
            ['gate', 'task-reset', '--task-id', taskId, '--reopen', '--confirm', '--repo-root', repoRoot],
            {
                mutates: true,
                confirmationPhrase: TASK_RESET_REOPEN_CONFIRMATION_PHRASE
            }
        ),
        buildUiActionDefinition(
            repoRoot,
            TASK_RESET_CLOSE_ACTION_ID,
            'Task',
            'Close without execution',
            'Close this task as DONE through the guarded task-reset gate after clearing runtime artifacts. The local UI uses confirmed one-action native authority without changing permanent reset policy.',
            ['gate', 'task-reset', '--task-id', taskId, '--to-status', 'DONE', '--confirm', '--repo-root', repoRoot],
            {
                mutates: true,
                confirmationPhrase: TASK_RESET_CLOSE_CONFIRMATION_PHRASE
            }
        ),
        buildUiActionDefinition(
            repoRoot,
            'task-stats',
            'Task',
            'Task stats',
            'Run the focused task stats command.',
            ['task', taskId, 'stats', '--target-root', repoRoot]
        ),
        buildUiActionDefinition(
            repoRoot,
            'task-events',
            'Task',
            'Task events',
            'Run the focused task events command.',
            ['task', taskId, 'events', '--target-root', repoRoot]
        )
    ];
}
