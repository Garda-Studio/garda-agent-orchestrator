import * as path from 'node:path';
import { listTaskPlans, readTaskPlan } from '../../core/task-plan-read';
import { saveTaskPlan } from '../../core/task-plan-save';
import { parseOptions } from './cli-helpers';

export function handleTaskPlan(argv: string[]): void {
    const action = argv[0];
    if (action !== 'list' && action !== 'show' && action !== 'save') {
        throw new Error('Task plan requires list, show <task-id>, or save <task-id> --input <file>.');
    }
    const { options, positionals } = parseOptions(argv.slice(1), {
        '--repo-root': { key: 'repoRoot', type: 'string' },
        ...(action === 'list' ? { '--missing': { key: 'missing', type: 'boolean' as const } } : {}),
        ...(action === 'save' ? { '--input': { key: 'input', type: 'string' as const } } : {})
    }, { allowPositionals: action !== 'list', maxPositionals: 1 });
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
    if (positionals.length !== 1) throw new Error(`Task plan ${action} requires exactly one task id.`);
    if (action === 'save') {
        if (!options.input) throw new Error('Task plan save requires --input <file>.');
        const savedPath = saveTaskPlan(repoRoot, positionals[0], String(options.input));
        console.log(`Task: ${positionals[0]}\nPlan: saved\nPath: ${path.relative(repoRoot, savedPath).replace(/\\/g, '/')}`);
        return;
    }
    const plan = readTaskPlan(repoRoot, positionals[0]);
    console.log(`Task: ${plan.task_id}\nPlan: ${plan.state}\nPath: ${plan.path}`);
    for (const diagnostic of plan.diagnostics) console.log(`Diagnostic: ${diagnostic}`);
    if (plan.content !== null) {
        console.log('JSON:');
        process.stdout.write(plan.content);
    }
}
