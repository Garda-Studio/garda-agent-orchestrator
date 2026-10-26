import * as moduleRuntime from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';

// Keep generated code outside source, installed bundles and their protected roots.
// Cache availability is advisory: permissions and unsupported runtimes fall back
// to ordinary compilation without changing CLI behavior.
try {
    if (typeof moduleRuntime.enableCompileCache === 'function') {
        moduleRuntime.enableCompileCache(path.join(os.homedir(), '.cache', 'garda', 'node-compile'));
    }
} catch { /* Node can run normally without a disk compile cache. */ }
