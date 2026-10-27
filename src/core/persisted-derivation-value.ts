import { types } from 'node:util';
import { createHash } from 'node:crypto';
import { countNextStepWork } from './next-step-measurement';
export const derivationHash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
export const isDerivationHash = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value);
/** Lossless own-data codec: preserve undefined, holes, -0 and property presence. No getters/toJSON. */
export function encodeDerivationValue(value: unknown): string {
    let budget = 100000;
    const ancestors = new Set<object>();
    function encode(value: unknown, depth: number): unknown {
        countNextStepWork('visit:q4_encode_value');
        if (--budget < 0 || depth > 128) throw new Error('Derivation value exceeds encoding bounds.');
        if (value === undefined) return ['undefined'];
        if (value === null || typeof value === 'string' || typeof value === 'boolean') return ['scalar', value];
        if (typeof value === 'number') return ['number', Object.is(value, -0) ? '-0' : String(value)];
        if (typeof value !== 'object' || types.isProxy(value) || ancestors.has(value)) throw new Error('Unsupported derivation value.');
        const prototype = Object.getPrototypeOf(value);
        if (Array.isArray(value) ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null)
            throw new Error('Unsupported derivation prototype.');
        if (Object.getOwnPropertySymbols(value).length) throw new Error('Unsupported derivation symbol.');
        ancestors.add(value);
        const fields: unknown[] = [];
        for (const [name, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
            countNextStepWork('visit:q4_encode_property');
            if (Array.isArray(value) && name === 'length') continue;
            if (!descriptor.enumerable || !('value' in descriptor)) throw new Error('Unsupported derivation property.');
            fields.push([name, encode(descriptor.value, depth + 1)]);
        }
        ancestors.delete(value);
        return Array.isArray(value) ? ['array', value.length, fields] : ['object', prototype === null, fields];
    }
    return JSON.stringify(encode(value, 0));
}
export function decodeDerivationValue(text: string): unknown {
    let budget = 100000;
    function decode(value: unknown, depth: number): unknown {
        countNextStepWork('visit:q4_decode_value');
        if (--budget < 0 || depth > 128 || !Array.isArray(value)) throw new Error('Invalid derivation encoding.');
        if (value[0] === 'undefined' && value.length === 1) return undefined;
        if (value[0] === 'scalar' && value.length === 2 && (value[1] === null || ['string','boolean'].includes(typeof value[1]))) return value[1];
        if (value[0] === 'number' && value.length === 2 && typeof value[1] === 'string') {
            const number = value[1] === '-0' ? -0 : Number(value[1]);
            if (String(number) !== value[1] && !['-0','NaN','Infinity','-Infinity'].includes(value[1])) throw new Error('Invalid number.');
            return number;
        }
        if (value.length !== 3 || !Array.isArray(value[2])) throw new Error('Invalid derivation container.');
        const array = value[0] === 'array';
        if ((!array && value[0] !== 'object') || (array ? !Number.isSafeInteger(value[1]) || value[1] < 0 || value[1] > 100000 : typeof value[1] !== 'boolean')) throw new Error('Invalid derivation container.');
        const result: Record<string, unknown> | unknown[] = array ? new Array(value[1]) : value[1] ? Object.create(null) as Record<string, unknown> : {};
        const seen = new Set<string>();
        for (const field of value[2]) {
            countNextStepWork('visit:q4_decode_property');
            if (!Array.isArray(field) || field.length !== 2 || typeof field[0] !== 'string' || seen.has(field[0]) || array && field[0] === 'length') throw new Error('Invalid derivation field.');
            seen.add(field[0]);
            Object.defineProperty(result, field[0], { enumerable: true, configurable: true, writable: true, value: decode(field[1], depth + 1) });
        }
        if (array && (result as unknown[]).length !== value[1]) throw new Error('Invalid array bound.');
        return result;
    }
    return decode(JSON.parse(text) as unknown, 0);
}
