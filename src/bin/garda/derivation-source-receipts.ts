// Load before application modules. This fixed bootstrap accepts no trust callback.
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import Module from 'node:module';
import { spawnSync } from 'node:child_process';
function installLoadedSourceReceipts(): void {
    const slot = Symbol.for('garda.loaded-source-receipts.v1');
    type LoaderFunction = (...args: unknown[]) => unknown;
    type CompiledModule = NodeModule & { _compile(source: string, filename: string): unknown; load: LoaderFunction };
    const prototype = Module.prototype as unknown as CompiledModule;
    const previous = prototype._compile;
    const receipts = new WeakMap<NodeModule, { file: string; sha256: string }>();
    function compile(this: CompiledModule, source: string, filename: string): unknown {
        const result = Reflect.apply(previous, this, [source, filename]);
        try {
            if (typeof source === 'string' && typeof filename === 'string') receipts.set(this,
                { file: filename, sha256: createHash('sha256').update(source, 'utf8').digest('hex') });
        } catch { /* Missing optional receipt must not replace the native module outcome. */ }
        return result;
    }
    function read(module: NodeModule): { file: string; sha256: string } | null {
        const found = receipts.get(module); return found ? { ...found } : null;
    }
    const startup = process.execArgv;
    let supportedStartup = !process.env.NODE_OPTIONS;
    for (let index = 0; index < startup.length; index++) {
        const option = startup[index];
        if (option === '-r' || option === '--require') {
            const target = startup[++index];
            try { if (!target || require.resolve(target) !== __filename) supportedStartup = false; }
            catch { supportedStartup = false; }
        } else if (option.startsWith('--require=') || option.startsWith('--loader') || option.startsWith('--import')) supportedStartup = false;
    }
    if (!supportedStartup || Object.prototype.hasOwnProperty.call(globalThis, slot)) return;
    // Do not accept an arbitrary preinstalled _compile closure merely because its text is hashable.
    // A fixed pristine child binds the same executable/runtime's native loader functions; no env is serialized.
    const nativeLoaderScript = "const M=require('node:module'),C=require('node:crypto');const f=[M.prototype._compile,M.prototype.load,M._load,M._resolveFilename,M._extensions['.js'],M._extensions['.json']];process.stdout.write(JSON.stringify([process.versions,C.createHash('sha256').update(f.map(x=>Function.prototype.toString.call(x)).join('\\0')).digest('hex')]));";
    const pristine = spawnSync(process.execPath, ['-e', nativeLoaderScript],
        { encoding: 'utf8', timeout: 10000, maxBuffer: 65536, windowsHide: true });
    if (pristine.error || pristine.status !== 0) return;
    let expectedLoader: unknown;
    try { expectedLoader = JSON.parse(pristine.stdout); } catch { return; }
    if (!Array.isArray(expectedLoader) || expectedLoader.length !== 2
        || JSON.stringify(expectedLoader[0]) !== JSON.stringify(process.versions)) return;
    const nativeModule = Module as unknown as { _load: LoaderFunction; _resolveFilename: LoaderFunction; _extensions: Record<string, LoaderFunction> };
    const actualLoader = createHash('sha256').update([previous, prototype.load, nativeModule._load,
        nativeModule._resolveFilename, nativeModule._extensions['.js'], nativeModule._extensions['.json']]
        .map(fn => Function.prototype.toString.call(fn)).join('\0')).digest('hex');
    if (actualLoader !== expectedLoader[1]) return;
    // Bind both the actual executing installer (including admission logic) and its current bytes.
    // No self-read is claimed as proof of what Node compiled before this module began executing.
    let sha256: string;
    try { sha256 = createHash('sha256').update(fs.readFileSync(__filename)).digest('hex'); }
    catch { return; }
    const previousJson = nativeModule._extensions['.json'];
    // Observe the exact native loader read. Do not reread after loading and label those
    // bytes as the source that Node parsed; a cached/unobserved source stays unavailable.
    function loadJson(this: unknown, module: unknown, filename: unknown): unknown {
        const io = require('node:fs') as { readFileSync: LoaderFunction };
        const nativeRead = io.readFileSync;
        let source: string | null = null, matchingReads = 0;
        function observeRead(this: unknown, ...args: unknown[]): unknown {
            const result = Reflect.apply(nativeRead, this, args);
            if (args[0] === filename && typeof result === 'string') { source = result; matchingReads += 1; }
            return result;
        }
        io.readFileSync = observeRead;
        try {
            const result = Reflect.apply(previousJson, this, [module, filename]);
            try {
                if (matchingReads === 1 && source !== null && typeof filename === 'string'
                    && module !== null && typeof module === 'object') receipts.set(module as NodeModule,
                        { file: filename, sha256: createHash('sha256').update(source, 'utf8').digest('hex') });
            } catch { /* Preserve native JSON loading even if optional receipt capture fails. */ }
            return result;
        } finally { io.readFileSync = nativeRead; }
    }
    prototype._compile = compile;
    nativeModule._extensions['.json'] = loadJson;
    Object.defineProperty(globalThis, slot, { value: Object.freeze({ version: 1, read, file: __filename, sha256,
        issuer: createHash('sha256').update(Function.prototype.toString.call(installLoadedSourceReceipts)
            + Function.prototype.toString.call(previous)).digest('hex') }),
        configurable: false, writable: false, enumerable: false });
}
try { installLoadedSourceReceipts(); } catch { /* Optional bootstrap unavailable. */ }
