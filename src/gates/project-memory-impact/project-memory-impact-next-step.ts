import type { ProjectMemoryImpactStatus } from './project-memory-impact-types';
import { PROJECT_MEMORY_MAP_WRITE_CONTRACT } from '../../core/project-memory';

const PROJECT_MEMORY_WRITE_AUTHORIZATION_GUIDANCE =
    'Reuse existing user approval or the active task instruction requiring project-memory maintenance for necessary in-scope updates; do not ask again. Obtain user approval before writes outside that authorization. Task start, memory-file existence, or suggested candidates alone do not authorize writes.';

export function buildProjectMemoryImpactNextStep(
    status: ProjectMemoryImpactStatus,
    affectedMemoryFiles: readonly string[]
): string {
    switch (status) {
        case 'OFF':
            return 'Project memory maintenance is disabled; no memory evidence is required.';
        case 'NO_UPDATE_NEEDED':
            return 'No durable project-memory update is required for the current changed-file scope.';
        case 'UPDATED':
            return 'Project memory update evidence is current for the affected memory files.';
        case 'BLOCKED':
            return `${PROJECT_MEMORY_WRITE_AUTHORIZATION_GUIDANCE} Resolve project-memory diagnostics, update only project-memory candidate files that need durable map changes, account for untouched candidates with --skip-unchanged-candidates-rationale, then rerun project-memory-impact with --confirm-updated. Authorization does not replace valid preflight or update evidence. ${PROJECT_MEMORY_MAP_WRITE_CONTRACT}`;
        case 'UPDATE_NEEDED':
        default:
            return affectedMemoryFiles.length > 0
                ? `${PROJECT_MEMORY_WRITE_AUTHORIZATION_GUIDANCE} Update candidate memory files when appropriate or account for unchanged candidates with a concrete rationale, then rerun with --confirm-updated; check mode remains advisory. ${PROJECT_MEMORY_MAP_WRITE_CONTRACT}`
                : 'Inspect project-memory diagnostics; check mode remains advisory.';
    }
}
