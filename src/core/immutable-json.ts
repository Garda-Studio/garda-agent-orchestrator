import { countNextStepWork } from './next-step-measurement';

/** Internal derived values contain only primitives, arrays and own data properties. */
function copyJson<T>(value: T, freeze: boolean): T {
    if (value === null || typeof value !== 'object') return value;
    const root: Record<string, unknown> | unknown[] = Array.isArray(value) ? new Array(value.length) : {};
    const copies = new Map<object, object>([[value, root]]);
    const pending = [{ source: value as object, target: root }];
    while (pending.length > 0) {
        const { source, target } = pending.pop()!;
        countNextStepWork('visit:derivation_json_cloned_object');
        for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(source))) {
            if (!descriptor.enumerable) continue;
            if (!('value' in descriptor)) throw new Error('Derived JSON cannot contain accessors.');
            const nested: unknown = descriptor.value;
            let child: unknown = nested;
            if (nested !== null && typeof nested === 'object') {
                child = copies.get(nested);
                if (!child) {
                    child = Array.isArray(nested) ? new Array(nested.length) : {};
                    copies.set(nested, child as object);
                    pending.push({ source: nested, target: child as Record<string, unknown> | unknown[] });
                }
            }
            // Define own keys (including __proto__) with JSON.parse semantics.
            Object.defineProperty(target, key, { value: child, enumerable: true, writable: true, configurable: true });
        }
        if (freeze) Object.freeze(target);
    }
    return root as T;
}

export function cloneJson<T>(value: T): T { return copyJson(value, false); }
export function cloneFrozenJson<T>(value: T): T { return copyJson(value, true); }
