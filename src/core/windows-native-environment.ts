import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export function getWindowsSystemDirectory(): string {
    return path.join(fs.realpathSync.native('\\\\?\\GLOBALROOT\\SystemRoot'), 'System32');
}

export function getWindowsNativeEnvironment(): NodeJS.ProcessEnv {
    const system32 = getWindowsSystemDirectory();
    const windowsRoot = path.dirname(system32);
    const powershellHome = path.join(system32, 'WindowsPowerShell', 'v1.0');
    // userInfo is OS-backed; os.homedir() honors mutable profile environment variables.
    const profile = fs.realpathSync.native(os.userInfo().homedir);
    const environment: NodeJS.ProcessEnv = {
        SystemRoot: windowsRoot,
        WINDIR: windowsRoot,
        USERPROFILE: profile,
        LOCALAPPDATA: path.join(profile, 'AppData', 'Local'),
        APPDATA: path.join(profile, 'AppData', 'Roaming'),
        PATH: [system32, powershellHome].join(path.delimiter),
        PSModulePath: path.join(powershellHome, 'Modules'),
        COMSPEC: path.join(system32, 'cmd.exe')
    };
    for (const name of ['TEMP', 'TMP'] as const) {
        const value = process.env[name];
        if (value && value.length <= 1_024) environment[name] = value;
    }
    return environment;
}
