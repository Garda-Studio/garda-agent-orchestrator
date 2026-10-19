import * as fs from 'node:fs';

export function observeIdentityAcquisitions(): { isActive(): boolean; restore(): void } {
    const identity = require('../../../../src/core/file-stat') as typeof import('../../../../src/core/file-stat');
    const mutableFs = require('node:fs') as typeof fs;
    let depth = 0;
    const originals = (['lstatFileIdentitySync', 'statFileIdentitySync', 'completePathFileIdentitySync'] as const)
        .map(name => {
            const descriptor = Object.getOwnPropertyDescriptor(identity, name)!;
            const original = identity[name];
            Object.defineProperty(identity, name, { ...descriptor, value: (...args: unknown[]) => {
                const originalRead = mutableFs.readSync;
                const originalReadFile = mutableFs.readFileSync;
                const originalReadv = mutableFs.readvSync;
                depth += 1;
                const rejectPayloadRead = () => {
                    throw new Error('Identity verification must not transfer payload bytes.');
                };
                mutableFs.readSync = rejectPayloadRead as typeof fs.readSync;
                mutableFs.readFileSync = rejectPayloadRead as typeof fs.readFileSync;
                mutableFs.readvSync = rejectPayloadRead as typeof fs.readvSync;
                try { return Reflect.apply(original, identity, args); }
                finally {
                    mutableFs.readSync = originalRead;
                    mutableFs.readFileSync = originalReadFile;
                    mutableFs.readvSync = originalReadv;
                    depth -= 1;
                }
            } });
            return { name, descriptor };
        });
    return {
        isActive: () => depth > 0,
        restore: () => { for (const { name, descriptor } of originals) Object.defineProperty(identity, name, descriptor); }
    };
}
