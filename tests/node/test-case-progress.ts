import { beforeEach } from 'node:test';
import { setImmediate } from 'node:timers';

// Capture the real scheduler before a scenario can replace timer APIs.
const scheduleImmediate = setImmediate;

export function registerTestCaseProgress(): void {
    // Long synchronous scenarios otherwise keep completed-test IPC queued
    // across a microtask chain, making genuine progress invisible to the runner.
    beforeEach(() => new Promise<void>((resolve) => scheduleImmediate(resolve)));
}
