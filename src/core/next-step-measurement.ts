export interface NextStepMeasurement {
    phases_ms: Record<string, number>;
    work: Record<string, number>;
}
let active: NextStepMeasurement | null = null;

export function countNextStepWork(name: string): void {
    if (active) active.work[name] = (active.work[name] || 0) + 1;
}

export function measureNextStepPhase<T>(name: string, action: () => T): T {
    if (!active) return action();
    const measurement = active;
    const started = performance.now();
    countNextStepWork(name);
    try { return action(); } finally {
        measurement.phases_ms[name] = (measurement.phases_ms[name] || 0) + performance.now() - started;
    }
}

export function withNextStepMeasurement<T>(action: () => T, receive?: (value: NextStepMeasurement) => void): T {
    if (active || (!receive && process.env.GARDA_NEXT_STEP_TIMING !== '1')) return action();
    const measurement: NextStepMeasurement = { phases_ms: {}, work: {} };
    active = measurement;
    try { return measureNextStepPhase('total', action); } finally {
        active = null;
        // Diagnostics must never change a navigation result or mask its original exception.
        try {
            receive?.(measurement);
            if (process.env.GARDA_NEXT_STEP_TIMING === '1') {
                process.stderr.write('GARDA_NEXT_STEP_TIMING ' + JSON.stringify(measurement) + '\n');
            }
        } catch { /* Optional diagnostics are best effort. */ }
    }
}
