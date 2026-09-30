import * as path from 'node:path';
import { listTaskPlans, readTaskPlan } from '../../core/task-plan-read';
import { parseOptions } from './cli-helpers';

export function handleTaskPlan(argv: string[]): void {
    const action = argv[0];
    if (action !== 'list' && action !== 'show') {
        throw new Error('Task plan requires list or show <task-id>.');
    }
    const { options, positionals } = parseOptions(argv.slice(1), {
        '--repo-root': { key: 'repoRoot', type: 'string' },
        ...(action === 'list' ? { '--missing': { key: 'missing', type: 'boolean' as const } } : {})
    }, { allowPositionals: action === 'show', maxPositionals: 1 });
    const repoRoot = path.resolve(String(options.repoRoot || '.'));
    if (action === 'list') {
        const plans = listTaskPlans(repoRoot, options.missing === true);
        console.log('GARDA_TASK_PLANS');
        for (const plan of plans) {
            console.log(`${plan.task_id}: ${plan.state}${plan.diagnostics.length ? ` (${plan.diagnostics.join('; ')})` : ''}`);
        }
        if (plans.length === 0) console.log('No eligible plans.');
        return;
    }
    if (positionals.length !== 1) throw new Error('Task plan show requires exactly one task id.');
    const plan = readTaskPlan(repoRoot, positionals[0]);
    console.log(`Task: ${plan.task_id}\nPlan: ${plan.state}\nPath: ${plan.path}`);
    for (const diagnostic of plan.diagnostics) console.log(`Diagnostic: ${diagnostic}`);
    if (plan.content !== null) {
        console.log('JSON:');
        process.stdout.write(plan.content);
    }
}
