import * as path from 'node:path';
import { compactGuidance } from '../../core/compact/guidance';
import { formatNextStepText, resolveNextStepFromCliOptions } from '../../gates/next-step/next-step';
import { runGateCliHandler } from './gate-cli-handler';
import { cachedUpdateAvailabilityNotice, prefetchUpdateAvailabilityNotice, scheduleUpdateAvailabilityCheck } from '../../lifecycle/update-availability/update-availability-worker';

export async function handleNextStep(gateArgv: string[]): Promise<void> {
    const defs = {
        '--task-id': { key: 'taskId', type: 'string' },
        '--preflight-path': { key: 'preflightPath', type: 'string' },
        '--repo-root': { key: 'repoRoot', type: 'string' },
        '--target-root': { key: 'repoRoot', type: 'string' },
        '--events-root': { key: 'eventsRoot', type: 'string' },
        '--reviews-root': { key: 'reviewsRoot', type: 'string' },
        '--execute-effects': { key: 'executeEffects', type: 'boolean' },
        '--effect-plan-sha256': { key: 'effectPlanSha256', type: 'string' },
        '--as-json': { key: 'asJson', type: 'boolean' }
    };
    let notice = '';
    return runGateCliHandler(gateArgv, defs, async (options: Parameters<typeof resolveNextStepFromCliOptions>[0]) => {
        const root = path.resolve(String(options.repoRoot || '.'));
        let readNotice: ReturnType<typeof prefetchUpdateAvailabilityNotice> | undefined;
        try {
            const result = resolveNextStepFromCliOptions(options, () => {
                readNotice ??= prefetchUpdateAvailabilityNotice(root);
            });
            if (result.status === 'DONE' && result.final_report) {
                notice = await (readNotice?.() ?? cachedUpdateAvailabilityNotice(root));
                await scheduleUpdateAvailabilityCheck(root);
            }
            return result;
        } finally {
            readNotice?.cancel();
        }
    }, {
        parseConfig: { allowPositionals: true, maxPositionals: 1 },
        mapOptions: ({ options, positionals }) => ({ ...options, positionals: [...positionals] }),
        formatOutput: (result, { options }) => {
            const repoRoot = path.resolve(String(options.repoRoot || '.'));
            const hint = result.status === 'DONE' ? '' : compactGuidance(repoRoot, result.task_id);
            return options.asJson === true
                ? `${JSON.stringify({ ...result, ...(hint ? { compact_hint: hint } : {}), ...(notice ? {
                    update_notice: notice,
                    update_notice_instruction: 'Append this English notice after the canonical final user report without changing that report.'
                } : {}) }, null, 2)}\n`
                : formatNextStepText(result) + (hint ? `\n${hint}\n` : '') + (notice
                    ? `\n${notice}\nAppend this English notice after the canonical final user report without changing that report.\n` : '');
        },
        resolveExitCode: () => 0
    });
}
