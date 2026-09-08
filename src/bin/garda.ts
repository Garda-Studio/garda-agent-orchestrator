#!/usr/bin/env node

import { findPackageRoot } from './garda/root-discovery';
import { resolveDelegatedLauncherTarget } from './garda/delegation-policy';
import { delegateToLocalCli } from './garda/process-delegation';
import { loadCliMainModule } from './garda/runtime-loading';

export * from './garda/root-discovery';
export * from './garda/runtime-loading';
export * from './garda/delegation-policy';
export * from './garda/process-delegation';

export async function main(argv: string[] = process.argv.slice(2), cwd: string = process.cwd()): Promise<void> {
    const packageRoot = findPackageRoot(__dirname);
    const delegatedCli = resolveDelegatedLauncherTarget(argv, cwd, __filename, packageRoot);
    if (delegatedCli) {
        process.exitCode = await delegateToLocalCli(delegatedCli, argv);
        return;
    }
    const { runCliMainWithHandling } = loadCliMainModule(packageRoot);
    await runCliMainWithHandling(argv, packageRoot);
}

if (require.main === module) {
    void main();
}
